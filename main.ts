#!/usr/bin/env -S deno run --allow-read --allow-write --allow-env --allow-net --allow-run --allow-sys
import * as FS from "@std/fs";
import * as Path from "@std/path";
import { Command, ValidationError } from "@cliffy/command";
import { CompletionsCommand } from "@cliffy/command/completions";
import { UpgradeCommand } from "@cliffy/command/upgrade";
import { JsrProvider } from "@cliffy/command/upgrade/provider/jsr";
import { Table } from "@cliffy/table";
import { colors } from "@cliffy/ansi/colors";
import { Input } from "@cliffy/prompt";
import denoConfig from "./deno.json" with { type: "json" };

type Runtime = "node" | "deno" | undefined;
type PackageManager = "npm" | "yarn" | "pnpm" | "deno";

interface Task {
  name: string;
  command: string;
  status: "running" | "stopped";
  startedAt?: number;
  pid?: number;
}

interface GitStatus {
  branch: string;
  isDirty: boolean;
  ahead: number;
  behind: number;
}

interface Project {
  id: string;
  projectDir: string;
  name: string;
  path: string;
  runtime: Runtime;
  packageManager: PackageManager;
  tasks: Record<string, Task>;
  git?: GitStatus;
}

interface Config {
  projectDirs: string[];
  groups?: Record<string, string[]>;
  editor?: string;
}

interface State {
  projectInCWD?: string;
  projects: Record<string, Project>;
  pidfile: Pids;
}

// project -> task -> pid
type Pids = Record<string, Record<string, number>>;

const BONK_HOME =
  Deno.env.get("BONK_HOME") ||
  (Deno.env.has("HOME") && Path.join(Deno.env.get("HOME")!, ".bonk")) ||
  ".bonk";
const BONK_CONFIG = Path.join(BONK_HOME, "config.json");
const BONK_PIDFILE = Path.join(BONK_HOME, "pidfile.json");

const HOME = Path.dirname(BONK_HOME);

const EMPTY_CONFIG: Config = { projectDirs: [] };

let EDITOR: string = "code";

const SIGIL = colors.bgBrightYellow.black(" bonk ");

async function ensureConfig(): Promise<Config> {
  await FS.ensureDir(BONK_HOME);
  if (!(await FS.exists(BONK_CONFIG))) {
    await Deno.writeTextFile(
      BONK_CONFIG,
      JSON.stringify(EMPTY_CONFIG, null, 2)
    );
  }
  return JSON.parse(await Deno.readTextFile(BONK_CONFIG));
}

async function ensurePidfile(): Promise<Pids> {
  await FS.ensureDir(BONK_HOME);
  if (!(await FS.exists(BONK_PIDFILE))) {
    await Deno.writeTextFile(BONK_PIDFILE, JSON.stringify({}, null, 2));
  }
  return JSON.parse(await Deno.readTextFile(BONK_PIDFILE));
}

async function updatePidfile(
  state: State,
  project: Project,
  task: Task,
  pid: number | undefined
) {
  if (pid !== undefined) {
    const pids = state.pidfile;
    if (!pids[project.id]) {
      pids[project.id] = {};
    }
    pids[project.id][task.name] = pid;
    await Deno.writeTextFile(BONK_PIDFILE, JSON.stringify(pids, null, 2));
    state.projects[project.id].tasks[task.name].pid = pid;
    state.projects[project.id].tasks[task.name].status = "running";
  } else {
    const pids = state.pidfile;
    if (pids[project.id]) {
      delete pids[project.id][task.name];
      await Deno.writeTextFile(BONK_PIDFILE, JSON.stringify(pids, null, 2));
      state.projects[project.id].tasks[task.name].pid = undefined;
      state.projects[project.id].tasks[task.name].status = "stopped";
    }
  }
}

async function getGitStatus(path: string): Promise<GitStatus> {
  // Common options for all git commands
  const cmdOptions = {
    cwd: path,
  };

  // Get current branch
  const branchCmd = new Deno.Command("git", {
    args: ["rev-parse", "--abbrev-ref", "HEAD"],
    ...cmdOptions,
  });
  const branchOutput = await branchCmd.output();
  const branch = new TextDecoder().decode(branchOutput.stdout).trim();

  // Check for uncommitted changes
  const statusCmd = new Deno.Command("git", {
    args: ["status", "--porcelain"],
    ...cmdOptions,
  });
  const statusOutput = await statusCmd.output();
  const isDirty =
    new TextDecoder().decode(statusOutput.stdout).trim().length > 0;

  // Get ahead/behind counts
  const aheadBehindCmd = new Deno.Command("git", {
    args: ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"],
    ...cmdOptions,
  });
  let ahead = 0;
  let behind = 0;

  try {
    const aheadBehindOutput = await aheadBehindCmd.output();
    const counts = new TextDecoder()
      .decode(aheadBehindOutput.stdout)
      .trim()
      .split(/\s+/);
    ahead = parseInt(counts[0]) || 0;
    behind = parseInt(counts[1]) || 0;
  } catch {
    // Handle case when there's no upstream branch
    ahead = 0;
    behind = 0;
  }

  return { branch, isDirty, ahead, behind };
}

function isAlive(pid: number): boolean {
  try {
    Deno.kill(pid, "SIGINFO");
    return true;
  } catch {
    return false;
  }
}

async function analyzeProject(
  projectDir: string,
  projectPath: string,
  pids: Record<string, number> = {},
  full: boolean = true
): Promise<Project | undefined> {
  // detect runtime
  let runtime: Runtime = undefined;
  if (await FS.exists(Path.join(projectPath, "deno.json"))) {
    runtime = "deno";
  } else if (await FS.exists(Path.join(projectPath, "package.json"))) {
    runtime = "node";
  }

  if (runtime === undefined) {
    // no runtime detected, this is not an interesting project
    return undefined;
  }

  // detect package manager
  let packageManager: PackageManager = runtime === "deno" ? "deno" : "npm";
  if (await FS.exists(Path.join(projectPath, "yarn.lock"))) {
    packageManager = "yarn";
  } else if (await FS.exists(Path.join(projectPath, "pnpm-lock.yaml"))) {
    packageManager = "pnpm";
  }

  // detect tasks
  const tasks: Record<string, Task> = {};
  if (runtime === "node") {
    const packageJson: Record<string, any> = JSON.parse(
      await Deno.readTextFile(Path.join(projectPath, "package.json"))
    );
    if (packageJson.scripts) {
      for (const [name, command] of Object.entries(
        packageJson.scripts as Record<string, string>
      )) {
        tasks[name] = { name, command, status: "stopped" };
      }
    }
  } else if (runtime === "deno") {
    const denoJson: Record<string, any> = JSON.parse(
      await Deno.readTextFile(Path.join(projectPath, "deno.json"))
    );
    if (denoJson.tasks) {
      for (const [name, command] of Object.entries(
        denoJson.tasks as Record<string, string>
      )) {
        tasks[name] = { name, command, status: "stopped" };
      }
    }
  }

  // detect git status
  let git: GitStatus | undefined = undefined;

  if (full) {
    // check if the project is a git repository
    if (await FS.exists(Path.join(projectPath, ".git"))) {
      git = await getGitStatus(projectPath);
    }
  }

  // check if there are any running tasks
  for (const [name, task] of Object.entries(tasks)) {
    if (pids[name]) {
      task.status = isAlive(pids[name]) ? "running" : "stopped";
      task.pid = pids[name];
    }
  }

  return {
    id: Path.join(projectDir, Path.basename(projectPath)),
    projectDir,
    name: Path.basename(projectPath),
    path: projectPath,
    runtime,
    packageManager,
    tasks,
    git,
  };
}

async function discoverState(
  projectDirs: string[],
  pids: Pids,
  full: boolean = true
): Promise<State> {
  const projects: Record<string, Project> = {};

  // iterate over each project directory, it should contain projetcs
  for (const projectDir of projectDirs) {
    const projectDirPath = Path.join(HOME, projectDir);
    if (!(await FS.exists(projectDirPath))) {
      console.warn(`Project directory not found: ${projectDirPath}`);
      continue;
    }

    // iterate over each directory
    for await (const dirEntry of Deno.readDir(projectDirPath)) {
      if (!dirEntry.isDirectory) continue;
      const projectPath = Path.join(projectDirPath, dirEntry.name);
      const key = `${projectDir}/${dirEntry.name}`;

      if (!(await FS.exists(projectPath))) {
        console.warn(
          `Project config not found: ${projectPath}. This is weird.`
        );
        continue;
      }
      try {
        const p = await analyzeProject(
          projectDir,
          projectPath,
          pids[key],
          full
        );
        if (p === undefined) {
          continue;
        }
        projects[key] = p;
      } catch (e) {
        console.warn(`Error analyzing project: ${projectPath}`, e);
        continue;
      }
    }
  }

  const projectInCWD = Object.values(projects).find((p) => {
    const absPath = Path.resolve(p.path);
    const cwd = Deno.cwd();
    return cwd.startsWith(absPath);
  })?.id;

  return { projects, projectInCWD, pidfile: pids };
}

const formatRuntime = (runtime: Runtime, packageManager: PackageManager) => {
  const pmcolor = {
    npm: colors.cyan,
    yarn: colors.green,
    pnpm: colors.brightGreen,
    deno: colors.magenta,
  }[packageManager];
  if (runtime === "node") {
    return `${colors.cyan(runtime)} ${pmcolor(packageManager)}`;
  }
  if (runtime === "deno") {
    return `${colors.magenta(runtime)}`;
  }
  return "N/A";
};

const formatGitStatus = (git: GitStatus) => {
  let status = "";
  status += git.isDirty ? colors.red(git.branch) : colors.dim(git.branch);
  if (git.ahead > 0) {
    status += colors.brightGreen(` ↑${git.ahead}`);
  }
  if (git.behind > 0) {
    status += colors.brightYellow(` ↓${git.behind}`);
  }
  return status;
};

const formatTasks = (tasks: Record<string, Task>) => {
  const sortedTasks = Object.values(tasks).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
  let output = "";
  for (const task of sortedTasks) {
    if (task.pid) {
      if (task.status === "running") {
        output += colors.brightGreen(`\u2022 ${task.name}`);
      } else {
        output += colors.brightRed(`\u2022 ${task.name}`);
      }
    } else {
      output += colors.dim(`\u2022 ${task.name}`);
      output += " ";
    }
  }

  return output;
};

const highlight = (text: string, filter: string) => {
  if (!filter) {
    return text;
  }
  const parts = text.split(filter);
  return parts.join(`${colors.bgBlue.black(filter)}`);
};

function ls(state: State) {
  return async (_options: void, ...[filter]: [string | undefined]) => {
    const table = new Table();
    // .header(
    //   new Row("Project", "Git", "Runtime", "Tasks").map((cell) =>
    //     colors.bold(cell)
    //   )
    // );
    const sortedProjects = Object.values(state.projects).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    //group porjects by projectDir
    const groupedProjects: Record<string, Project[]> = {};
    for (const project of sortedProjects) {
      if (filter && !project.id.includes(filter)) {
        continue;
      }
      const key = project.projectDir;
      if (!groupedProjects[key]) {
        groupedProjects[key] = [];
      }
      groupedProjects[key].push(project);
    }

    for (const group of Object.keys(groupedProjects).sort()) {
      table.push([]);
      table.push([
        colors.bold(
          filter
            ? highlight(Path.basename(group), filter)
            : Path.basename(group)
        ),
      ]);
      let i = 0;
      for (const project of groupedProjects[group]) {
        i++;
        if (filter && !project.id.includes(filter)) {
          continue;
        }

        let treeNode = "├─";
        if (i === groupedProjects[group].length) {
          treeNode = "└─";
        }
        treeNode = colors.dim(treeNode);

        let projectName = filter
          ? highlight(project.name, filter)
          : project.name;

        if (project.id === state.projectInCWD) {
          projectName = colors.underline(projectName);
        }

        project.git = project.git ?? (await getGitStatus(project.path));

        const git = project.git ? formatGitStatus(project.git) : "";
        table.push([
          treeNode + "" + projectName,
          git,
          formatRuntime(project.runtime, project.packageManager),
          formatTasks(project.tasks),
        ]);
      }
    }
    table.render();
  };
}

async function disambiguateProject(
  state: State,
  filter: string
): Promise<Project> {
  if (filter.length === 0) {
    throw new Error("No project specified");
  }

  // direct path match
  if (state.projects[filter]) {
    return state.projects[filter];
  }

  const candidates = Object.values(state.projects).filter((p) =>
    p.id.includes(filter)
  );
  if (candidates.length === 0) {
    throw new Error(`No project found matching: ${filter}`);
  }
  if (candidates.length === 1) {
    return candidates[0];
  }
  const choice = await Input.prompt({
    message: `Multiple projects matching ${filter} found. Please select one:`,
    list: true,
    info: true,
    suggestions: candidates.map((p) => p.id),
  });

  console.log("choice:", choice);
  return state.projects[choice];
}

function edit(state: State) {
  return async (_options: void, ...[project]: [string | undefined]) => {
    try {
      if (!project) project = state.projectInCWD;

      if (!project) throw new Error("No project specified");

      const p = await disambiguateProject(state, project);

      // launch editor
      const cmd = new Deno.Command(EDITOR, { args: [p.path] });
      await cmd.output();
    } catch (e) {
      throw e;
    }
  };
}

function cd(state: State) {
  return async (_options: void, ...[project]: [string | undefined]) => {
    try {
      if (!project) project = state.projectInCWD;

      if (!project) throw new Error("No project specified");

      const p = await disambiguateProject(state, project);

      const sh = Deno.env.get("SHELL") || "sh";

      console.log(
        `${SIGIL} ${colors.brightYellow("\u2192")} ${
          p.id
        } ${colors.brightYellow("\u2192")} ${colors.dim(sh)}`
      );

      console.log(
        `${colors.bgYellow.black(" HEY! ")} ${colors.brightYellow(
          `This is a nested shell, remember to exit when you're done.`
        )}`
      );

      // spawn shell in project directory
      const shell = new Deno.Command(sh, {
        cwd: p.path,
        stderr: "inherit",
        stdout: "inherit",
        stdin: "inherit",
      });
      await shell.output();
    } catch (e) {
      throw e;
    }
  };
}

async function findTask(
  state: State,
  [project, task, ...args]: [
    string | undefined,
    string | undefined,
    ...string[]
  ]
): Promise<{ task: Task; project: Project; rest: string[] }> {
  let proj: Project | undefined = undefined;
  let usedDefault = false;

  // first see if we are in a project
  if (state.projectInCWD) {
    proj = state.projects[state.projectInCWD];
    usedDefault = true;
  }

  if (project && task && proj) {
    // try to match first parameter as project
    try {
      proj = await disambiguateProject(state, project);
      usedDefault = false;
    } catch (e: any) {
      if (!usedDefault) {
        throw new Error("No project specified", e.message);
      }
    }
  }

  // sanity check
  if (!proj) {
    console.log(project, task, proj, usedDefault);
    throw new Error("No project specified, bug?");
  }

  if (Object.keys(proj.tasks).length === 0) {
    throw new Error("No tasks found in project");
  }

  // if we assumed the project, we need to treat first argument as task
  let taskName = usedDefault ? project : task;

  // if we don't have a task, we need ask the user
  if (!taskName) {
    const taskChoice = await Input.prompt({
      message: `Please select a task:`,
      list: true,
      info: true,
      suggestions: Object.keys(proj.tasks),
    });
    taskName = taskChoice;
  }

  // sanity check
  if (!taskName) {
    throw new Error("No task specified");
  }

  // if we got a partial task name, we need to disambiguate
  if (!proj.tasks[taskName]) {
    const candidates = Object.keys(proj.tasks).filter(
      (t) => t.includes(taskName as string) // as is safe here because we checked above
    );
    if (candidates.length === 0) {
      throw new Error(`No task found matching: ${taskName}`);
    }
    if (candidates.length === 1) {
      taskName = candidates[0];
    } else {
      const choice = await Input.prompt({
        message: `Multiple tasks matching ${taskName} found. Please select one:`,
        list: true,
        info: true,
        suggestions: candidates,
      });
      taskName = choice;
    }
  }

  const taskObj = proj.tasks[taskName];

  const rest = args;

  if (usedDefault && task) {
    rest.unshift(task);
  }

  return { task: taskObj, project: proj, rest };
}

const formatProjectName = (state: State, id: string) => {
  if (id === state.projectInCWD) {
    return colors.underline(id);
  }
  return id;
};

function run(state: State) {
  return async (
    { bg }: { bg: unknown },
    ...args: [string | undefined, string | undefined, ...string[]]
  ) => {
    const { task: taskObj, project: proj, rest } = await findTask(state, args);

    if (taskObj.pid) {
      if (isAlive(taskObj.pid)) {
        console.log(
          `${SIGIL} ${colors.brightYellow("\u2192")} ${formatProjectName(
            state,
            proj.id
          )} ${colors.brightYellow("\u2192")} ${colors.brightGreen(
            taskObj.name
          )}\n${colors.bgBrightGreen.black("  UP  ")} Task is already running`
        );
        await updatePidfile(state, proj, taskObj, taskObj.pid);
        return;
      }
    }

    const handler = {
      deno: { executable: "deno", args: ["task"] },
      npm: { executable: "run", args: ["run"] },
      yarn: { executable: "yarn", args: ["run"] },
      pnpm: { executable: "pnpm", args: ["run"] },
    }[proj.packageManager];

    console.log(
      `${SIGIL} ${colors.brightYellow("\u2192")} ${formatProjectName(
        state,
        proj.id
      )} ${colors.brightYellow("\u2192")} ${colors.brightGreen(
        taskObj.name
      )} ${colors.dim(": " + taskObj.command)}`
    );

    if (!(bg as boolean)) {
      const cmd = new Deno.Command(handler.executable, {
        args: handler.args.concat(taskObj.name).concat(rest),
        cwd: proj.path,
        stderr: "inherit",
        stdout: "inherit",
        stdin: "inherit",
      });
      await cmd.output();
    } else {
      const cmd = new Deno.Command(handler.executable, {
        args: handler.args.concat(taskObj.name).concat(rest),
        cwd: proj.path,
        stderr: "null",
        stdout: "null",
        stdin: "null",
      });
      const child = cmd.spawn();
      if (!child.pid) {
        throw new Error("Failed to start task");
      }
      await updatePidfile(state, proj, taskObj, child.pid);
      child.unref();
      console.log(
        `${colors.bgBrightGreen.black(
          "  UP  "
        )} Task started in background with PID: ${child.pid}`
      );
      Deno.exit(0);
    }
  };
}

async function getPgid(pid: number): Promise<number> {
  const cmd = new Deno.Command("ps", {
    args: ["-o", "pgid=", "-p", pid.toString()],
    stdout: "piped",
  });
  const output = await cmd.output();
  const pgid = new TextDecoder().decode(output.stdout).trim();
  return parseInt(pgid);
}

function stop(state: State) {
  return async (
    _options: void,
    ...args: [string | undefined, string | undefined]
  ) => {
    const { task: taskObj, project: proj } = await findTask(state, args);
    console.log(
      `${SIGIL} ${colors.brightYellow("\u2192")} ${
        proj.id
      } ${colors.brightYellow("\u2192")} ${colors.brightRed(taskObj.name)}`
    );

    const pid = proj.tasks[taskObj.name].pid;

    if (pid === undefined) {
      console.log(
        `${colors.bgBrightRed.black(" DOWN ")} Task is not running, did nothing`
      );
      return;
    }

    if (!isAlive(pid)) {
      await updatePidfile(state, proj, taskObj, undefined);
      console.log(
        `${colors.bgBrightRed.black(
          " DOWN "
        )} Task is not running even though it should, cleared pidfile`
      );
      return;
    }

    const pgid = await getPgid(pid);
    Deno.kill(-pgid, "SIGTERM");
    await updatePidfile(state, proj, taskObj, undefined);
    console.log(`${colors.bgBrightRed.black(" DOWN ")} Task stopped`);
    return;
  };
}

type EmoticonCategory = "tableFlip" | "annoyed" | "all";

const emoticons = {
  tableFlip: [
    "(╯°□°)╯︵ ┻━┻",
    "(ノಠ益ಠ)ノ彡┻━┻",
    "┻━┻ ︵ヽ(`Д´)ﾉ︵ ┻━┻",
    "(┛◉Д◉)┛彡┻━┻",
  ],
  annoyed: [
    "(；￣Д￣)",
    "╮(╯▽╰)╭",
    "(눈_눈)",
    "(；¬_¬)",
    "ಠ_ಠ",
    "(｀Д´)",
    "(╬ಠ益ಠ)",
  ],
};

function getRageEmoticon(category: EmoticonCategory = "all"): string {
  if (category === "all") {
    const allEmoticons = [...emoticons.tableFlip, ...emoticons.annoyed];
    return allEmoticons[Math.floor(Math.random() * allEmoticons.length)];
  }

  const categoryEmoticons = emoticons[category];
  return categoryEmoticons[
    Math.floor(Math.random() * categoryEmoticons.length)
  ];
}

function projectCompleter(state: State) {
  return () => {
    const allProjects = Object.keys(state.projects).sort();
    if(state.projectInCWD) {
      // remove current project from list
      allProjects.splice(allProjects.indexOf(state.projectInCWD), 1);
      // put current project at the top
      allProjects.unshift(state.projectInCWD);
      // put tasks from current project at the top
      const projectTasks = Object.keys(state.projects[state.projectInCWD].tasks).sort();
      return projectTasks.concat(allProjects);
    }
    return allProjects;
  };
}

function taskCompleter(state: State) {
  return () => {
    const taskSet = new Set<string>();
    for (const project of Object.values(state.projects)) {
      for (const task of Object.keys(project.tasks)) {
        taskSet.add(task);
      }
    }
    if(state.projectInCWD) {
      const projectTasks = Object.keys(state.projects[state.projectInCWD].tasks).sort();
      for(const task of projectTasks) {
        taskSet.delete(task);
      }
      return projectTasks.concat(Array.from(taskSet));
    }
    return Array.from(taskSet);
  };
}

async function main() {
  const config = await ensureConfig();

  if (config.editor) {
    EDITOR = config.editor;
  }

  if (config.projectDirs.length === 0) {
    console.log(`${SIGIL} ${getRageEmoticon("all")}
${colors.bgBrightRed.black(" OOPS ")} ${colors.brightRed(
      "No project directories found. Please add some directories to the bonk config."
    )}

Your config file is located at: ${colors.brightBlue(BONK_CONFIG)}
The paths are relative to your home directory which is: ${colors.brightBlue(HOME)}

Example:
${colors.dim(`{
  "projectDirs": [
    "personal",
    "work"
  ]
}`)}
`);
    return;
  }

  const pids = await ensurePidfile();
  const state = await discoverState(config.projectDirs, pids, false);

  const mainCommand = new Command()
    .throwErrors()
    .name("bonk")
    .version(denoConfig.version)
    .description("Bonk is your chaotic-good JS project companion.")
    .action(() => {
      console.log(
        `${SIGIL} ${colors.brightYellow("(っ•﹏•)っ ✂")} ${colors.dim(
          "v" + mainCommand.getVersion()!
        )}\n       ${mainCommand.getDescription()}`
      );

      const originalHelp = mainCommand.getHelp().split("\n");
      // get rid of everything before the line containing "Options:"
      let print = false;
      for(const line of originalHelp) {
        if(line.includes("Options:")) {
          console.log("\n" + line);
          print = true;
          continue;
        }
        if(print) {
          console.log(line);
        }
      }
    })
    // ls
    .command("ls", "List your projects. Optionally filter by project name")
    .alias("l")
    .arguments("[filter:string]")
    .action(ls(state))
    // edit
    .command("edit", "Edit project in your favorite editor.")
    .alias("e")
    .arguments("[project:string:project]")
    .complete("project", projectCompleter(state))
    .action(edit(state))
    // cd
    .command("cd", "Open a shell in a project.")
    .alias("c")
    .arguments("[project:string:project]")
    .complete("project", projectCompleter(state))
    .action(cd(state))
    // run
    .command("run", "Run a task in a project.")
    .alias("r")
    .arguments("[project:string:project] [task:string:task] [...args]")
    .complete("project", projectCompleter(state))
    .complete("task", taskCompleter(state))
    .option("-b, --bg, --background", "Run in background", { default: false })
    .action(run(state))
    // stop
    .command("stop", "Stop a background task in a project.")
    .alias("s")
    .arguments("[project:string:project] [task:string:project]")
    .complete("project", projectCompleter(state))
    .complete("task", taskCompleter(state))
    .action(stop(state))
    // completions
    .command("completions", new CompletionsCommand())
    // upgrade
    .command(
      "upgrade",
      new UpgradeCommand({
        provider: [
          new JsrProvider({ scope: "nooga"}),
        ],
      }),
    )

  try {
    await mainCommand.parse(Deno.args);
  } catch (error: any) {
    if (error instanceof ValidationError) {
      error.cmd?.showHelp();
      console.error("Usage error: %s", error.message);
      Deno.exit(error.exitCode);
    } else {
      console.log(
        `${SIGIL} ${getRageEmoticon("all")}\n${colors.bgBrightRed.black(
          " DAMN "
        )} ${colors.brightRed(error.message)}`
      );
      Deno.exit(1);
    }
  }
}

if (import.meta.main) {
  main();
}
