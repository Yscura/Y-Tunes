<p align="center"><img src="icon.png" width="128" alt="YTunes icon"></p>

# YTunes

A Discord music bot that plays YouTube in your voice channel. Type `/play` with a song name and it plays the first result, or paste a video or playlist link.

- Search, video links and whole playlists
- A queue with shuffle, loop, seek and volume
- Pause, skip, stop, shuffle and loop buttons on the "Now playing" message
- Autoplay of related songs when the queue runs out
- Automatic skipping of non-music sections, sponsors and subscribe reminders, using [SponsorBlock](https://sponsor.ajay.app)
- Saved playlists for each server
- An optional DJ role that limits who can control playback
- Resumes where it left off after a restart

## Setup

### 1. Requirements

- [Node.js](https://nodejs.org) 18 or newer (tested on 22)

You don't need to install anything else. yt-dlp and ffmpeg are downloaded automatically during `npm install`.

### 2. Create the Discord bot

1. Go to the [Discord Developer Portal](https://discord.com/developers/applications) and click **New Application**.
2. Open the **Bot** tab and click **Reset Token**. Copy the token and keep it secret; anyone who has it can control your bot.
3. Open **OAuth2 → URL Generator** and tick:
   - **Scopes:** `bot` and `applications.commands`
   - **Bot permissions:** View Channels, Send Messages, Embed Links, Connect and Speak
4. Open the generated URL and add the bot to your server.

No privileged intents are needed. You can leave all three switches on the Bot tab off.

### 3. Install and configure

```sh
git clone <this repo>
cd YTunes
npm install
```

Copy `.env.example` to `.env` and fill it in:

```ini
DISCORD_TOKEN=your-bot-token
GUILD_ID=your-server-id
```

`GUILD_ID` is optional, but recommended. With it, slash commands show up in that server right away. Without it, they're registered for every server the bot is in, which can take up to an hour.

To find your server ID, enable **Developer Mode** (User Settings → Advanced), then right-click your server and choose **Copy Server ID**.

### 4. Run

```sh
npm start
```

You should see:

```
Logged in as YourBot#1234
Registered 20 slash commands in guild 123456789012345678
```

Join a voice channel and type `/play never gonna give you up`.

Stop the bot with **Ctrl+C**. It saves what was playing, so the next `npm start` picks up where it left off.

## Running on a Raspberry Pi (or any Linux server)

To keep the bot running all the time, install it as a systemd service. It then starts on boot, restarts if it crashes, and keeps retrying until the network is up. After a power cut it comes back on its own and resumes the music, as long as someone is still in the voice channel.

**Hardware:** a Raspberry Pi 3, 4 or 5 running the **64-bit** Raspberry Pi OS is recommended. Some of the audio components don't ship ready-made builds for 32-bit systems or the Pi Zero.

### 1. Install Node.js and the build tools

```sh
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs git python3 build-essential
```

On Linux, yt-dlp runs on Python (`python3`, which Raspberry Pi OS already has). `build-essential` is only used if `@discordjs/opus` has to be compiled.

### 2. Get the bot and configure it

```sh
git clone <this repo> ~/YTunes
cd ~/YTunes
npm install
cp .env.example .env
nano .env        # add DISCORD_TOKEN and GUILD_ID
```

Check that it works with `npm start`, then stop it with Ctrl+C.

### 3. Install the service

```sh
sudo bash scripts/install-service.sh
```

The script runs the bot as your user, from this folder, with the Node.js it finds (nvm installs are supported). It also starts the bot right away.

| Task | Command |
|---|---|
| Live logs | `journalctl -u ytunes -f` |
| Status | `systemctl status ytunes` |
| Restart | `sudo systemctl restart ytunes` |
| Stop until next boot | `sudo systemctl stop ytunes` |
| Remove the service | `sudo bash scripts/install-service.sh --uninstall` |

To update the bot:

```sh
cd ~/YTunes && git pull && npm install && sudo systemctl restart ytunes
```

If you move the folder, run the install script again.

## Commands

### Playing music

| Command | Description |
|---|---|
| `/play <query>` | Play a song, video link or playlist link. Search terms play the first YouTube result. |
| `/playnext <query>` | Like `/play`, but adds to the front of the queue. |
| `/search <query>` | Shows the top 5 results in a dropdown so you can choose. |
| `/pause` / `/resume` | Pause or resume playback. `/resume` also brings back a queue saved by `/stop`. |
| `/skip` | Skip the current song. |
| `/stop` | Stop and leave the voice channel. The current song (and where it was) and the queue are saved for `/resume`. |
| `/seek <time>` | Jump to a time in the song, such as `1:30` or `90`. |
| `/volume [0–100]` | Show or set the volume. |
| `/nowplaying` | Show the current song with a progress bar. |

The "Now playing" message has buttons for pause/resume, skip, stop, shuffle and loop. You only need to type commands for the less common actions.

### Queue

| Command | Description |
|---|---|
| `/queue [page]` | Show what's playing and what's next. |
| `/shuffle` | Shuffle the queue. |
| `/loop <off\|song\|queue>` | Repeat the current song or the whole queue. |
| `/remove <position>` | Remove a song, using its number from `/queue`. |
| `/clear` | Empty the queue, including one saved by `/stop`. The current song keeps playing. |

When you play a playlist link, every song is added to the queue (up to 200). A link to a video inside a playlist (`watch?v=…&list=…`) starts from that video.

### Saved playlists

| Command | Description |
|---|---|
| `/playlist save <name>` | Save the current song and queue under a name. |
| `/playlist load <name>` | Add a saved playlist to the queue. |
| `/playlist list` | List this server's saved playlists. |
| `/playlist show <name>` | Show the songs in a playlist. |
| `/playlist delete <name>` | Delete a playlist. |

Names autocomplete as you type. Only the person who created a playlist, or someone with Manage Server, can overwrite or delete it.

### Settings

| Command | Description |
|---|---|
| `/autoplay <True/False>` | When the queue runs out, keep playing related songs. Off by default. |
| `/sponsorblock <True/False>` | Skip non-music sections, sponsors and subscribe reminders. On by default. |
| `/dj set <role>` / `/dj clear` | Limit playback controls to a DJ role (see below). Needs Manage Server. |
| `/settings` | Show this server's settings. |

## Who can do what

- **Playback controls** (buttons, `/skip`, `/pause` and so on) only work while you're in the bot's voice channel. Anyone can view `/queue` and `/nowplaying`.
- **Without a DJ role**, everyone in the channel can control playback.
- **With a DJ role**, only members with the role, or with Manage Server, can pause, stop, seek, loop, shuffle, clear, change the volume, use `/playnext` or change settings. Everyone can still queue songs, load playlists, and skip or remove their own songs and autoplay picks. Someone alone with the bot counts as a DJ.

## Good to know

- **Auto-leave:** the bot leaves after 3 minutes if nothing is playing or nobody else is in the channel. Like `/stop`, it saves the queue for `/resume` (the same happens if someone disconnects the bot).
- **Resume after restart:** the bot saves the queue every few seconds. After a restart it rejoins and continues, but only if someone is still in the channel.
- **Stored data:** saved playlists, settings, the resume state and queues saved by `/stop` are kept as JSON files in `data/`. Back that folder up if you care about the playlists. It's excluded from git.
- **Video:** Discord doesn't let bots stream video, so YTunes plays audio only.
- **Network hiccups:** the bot downloads ahead and waits up to 10 seconds through a stall. If a stream drops completely, it retries once from the same spot. Only then does it skip the song, and it posts "⚠️ Lost the stream for …" when it does.

## Troubleshooting

**Slash commands don't show up.** Set `GUILD_ID` in `.env` and restart. Without it, commands can take up to an hour to appear. Also check that the bot was invited with the `applications.commands` scope.

**The bot joins but there's no sound.** Check that it has the **Speak** permission in that channel, and that it isn't server-muted.

**Songs suddenly fail to play or search.** YouTube changes things fairly often, and an updated yt-dlp usually fixes it:

```sh
npm install youtube-dl-exec@latest
```

**`npm install` fails on `@discordjs/opus`.** It ships prebuilt binaries for common platforms. On others it needs build tools: Python and a C++ compiler. On Windows that's the "Desktop development with C++" workload from Visual Studio Build Tools.

## Project layout

```
src/
  index.js         Startup, command registration, routing interactions
  commands.js      Slash command definitions and handlers
  player.js        Per-server playback: queue, controls, autoplay, SponsorBlock, resume
  youtube.js       Search, playlists and audio streaming via yt-dlp + ffmpeg
  sponsorblock.js  SponsorBlock segment lookups
  playlists.js     Saved playlists
  settings.js      Per-server settings
  sessions.js      Saved playback state (resume after restart, queues kept by /stop)
  store.js         Small JSON-file storage helper
scripts/
  install-service.sh  Installs the systemd service (Linux / Raspberry Pi)
data/              Created at runtime (git-ignored)
```
