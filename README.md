# bonk (っ•﹏•)っ ✂

**HELLO FELLOW TYPESCRIPT ENJOYERS!** (and yes, by TypeScript I mean JavaScript too, we're all in this together)

Are your projects scattered across your system? Do you find yourself `cd`-ing through directories like a lost tourist with a broken compass? Forgetting whether it was `yarn`, `npm`, `pnpm`, or `interpretive dance` that this project uses? Need to run seventeen background tasks across five projects but your terminal tabs look like an accordion?

🎪 **STEP RIGHT UP TO THE GREATEST SHOW IN YOUR TERMINAL!** 🎪

**BEHOLD!** The absolutely **CHAOTIC-GOOD** project manager that treats your JavaScript projects like a cat treats gravity - **WITH COMPLETE DISREGARD! (╯°□°)╯︵ ┻━┻**

- 🌟 **WITNESS** as it _SNIFFS OUT_ your projects faster than a caffeinated bloodhound with a computer science degree!
- 🎭 **GASP** as it _TELEPORTS_ between directories like a quantum-tunneling kangaroo!
- ✨ **MARVEL** as it _LAUNCHES_ editors with the enthusiasm of a rocket-powered penguin!
- 🎪 **APPLAUD** as it _JUGGLES_ background tasks like a circus octopus on espresso!

## ⚡️ OBTAINING THIS MIRACLE OF MODERN ENGINEERING ⚡️

```bash
deno install -gArf jsr:@nooga/bonk
```

## ⚡️ CONFIGURING THIS BAD BOY! ⚡️

Before first use, you'll need to tell `bonk` where your projects live. Create or edit `~/.bonk/config.json`:

```json
{
  "projectDirs": ["projects", "work", "personal", "playground"]
}
```

The `projectDirs` are directories that _contain_ your projects, relative to your home directory (`~`). For example, if your projects are in:

- `~/projects/awesome-app`
- `~/projects/another-project`
- `~/work/secret-startup`
- `~/personal/weekend-hack`

You would configure `projectDirs` as `["projects", "work", "personal"]`, and bonk will automatically scan these directories for Node.js and Deno projects.

Optional configuration:

- `editor`: Your preferred editor command (defaults to `code`)

## ✨ THE ART OF BONKING (A BEGINNER'S GUIDE)

### 📋 `bonk ls [filter]`

Lists your projects like a hyperactive inventory system! Shows:

- Projects (as a fancy tree! 🌳)
- Git status (le brunch? dirty? ahead? BEHIND? EVERYTHING! 📊)
- Runtime & package manager (`npm`/`yarn`/`pnpm`/`deno` circus 🎪)
- Available tasks and their status (with cute little dots! 👀)

Filter your projects faster than a caffeinated grep! Just type part of the name!

### 🚀 `bonk run [project] [task] [...args]`

Launch tasks like a mission control operator on a sextuple espresso!

- Automagically detects the right package manager!
- Runs in foreground by default (because we like to watch things happen)
- Add `--bg` flag to banish it to the background realm!
- Pass extra args after the task name, they'll find their way!

### 🛑 `bonk stop [project] [task]`

Stops tasks with the grace of a ballet-dancing **kill -9**!

- Hunts down background processes like a determined task predator
- Shows no mercy to zombie processes
- Cleans up after itself like a responsible citizen

### 📂 `bonk cd [project]`

Teleports you into project directories faster than quantum tunneling!

- Opens a new shell in your project
- Exit to pop back out (like a stack, but for humans!)
- No more `cd ../../../whatever/something/else`!

### ✏️ `bonk edit [project]`

Summons your editor of choice like a well-trained digital familiar!

- Configurable via `editor` in `~/.bonk/config.json`
- Defaults to `code` because we're savages

### 🤯 BEST PART?

If you're already IN a project directory, you can skip the project name! BOOM! 🎆
Example: `bonk run test` will just work! (assuming you have a test script, if not, why not? 🤔)

Too busy to type? Just use the first letter of the task: `bonk run t`!

## ⚡️ BONK! ⚡️

Because your projects deserve a manager that's one `sudo` away from achieving sentience!

(ﾉ ◕ ヮ ◕)ﾉ*:･ﾟ ✧ *maniacal laughter intensifies* ✧ ﾟ･: *ヽ(◕ ヮ ◕ ヽ)
