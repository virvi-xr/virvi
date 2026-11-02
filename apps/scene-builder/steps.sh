# Shared by entrypoint.sh and smoke.sh (sourced, as root): how each user is started, and the root-side guards.
# smoke.sh checks the isolation with these same functions, so what it proves is what a build gets.

npm_proxy=http://127.0.0.1:8888
api_proxy=http://127.0.0.1:8889

# Unsets every exported variable not named in $1 (in the calling subshell), then sets the user's basics
scrub_env() {
  local keep=$1 user=$2 v
  for v in $(compgen -e); do
    case " $keep " in *" $v "*) ;; *) unset "$v" ;; esac
  done
  export HOME=/home/$user USER=$user LOGNAME=$user PATH=/usr/local/bin:/usr/bin:/bin
}

# Execs a command as `user` with every capability dropped and no way to gain privileges (no setuid)
drop_to() {
  local user=$1
  shift
  exec setpriv --reuid="$user" --regid="$user" --init-groups --no-new-privs --inh-caps=-all --bounding-set=-all -- "$@"
}

# The trusted steps: the token and the Virvi proxy, nothing else. Values travel in the environment, never argv.
as_runner() (
  export NODE_USE_ENV_PROXY=1 HTTPS_PROXY=$api_proxy https_proxy=$api_proxy NO_PROXY=localhost,127.0.0.1
  scrub_env "BUILD_SOURCE_URL BUILD_RESULT_URL BUILD_FAILED_URL BUILD_TOKEN NODE_USE_ENV_PROXY HTTPS_PROXY https_proxy NO_PROXY" runner
  drop_to runner "$@"
)

# The scene's code: the npm proxy and nothing else, no BUILD_* at all
as_builder() (
  export HTTPS_PROXY=$npm_proxy https_proxy=$npm_proxy HTTP_PROXY=$npm_proxy http_proxy=$npm_proxy NO_PROXY=localhost,127.0.0.1 \
    npm_config_proxy=$npm_proxy npm_config_https_proxy=$npm_proxy npm_config_update_notifier=false CI=true
  scrub_env "HTTPS_PROXY https_proxy HTTP_PROXY http_proxy NO_PROXY npm_config_proxy npm_config_https_proxy npm_config_update_notifier CI" builder
  drop_to builder "$@"
)

# Kills every `builder` process at once (kill(-1) as builder: everything the uid owns), until none is left
kill_builder() {
  for _ in $(seq 20); do
    pgrep -u builder > /dev/null || return 0
    setpriv --reuid=builder --regid=builder --clear-groups -- kill -KILL -1 2> /dev/null || true
    sleep 0.1
  done
  ! pgrep -u builder > /dev/null
}

# Fly mounts its Machines API at /.fly/api: a Unix socket with the app's credentials, which nftables can't see.
# Remove it and lock the directory (and anything else Fly put there) to root.
lock_fly() {
  [ -e /.fly ] || return 0
  rm -f /.fly/api
  chown -R root:root /.fly
  chmod -R go-rwx /.fly
  chmod 700 /.fly
}

# Fails (non-zero, naming what it found) if `builder` can reach anything the firewall can't see: any listening
# Unix socket in this network namespace (abstract ones included, which file permissions don't cover), or /.fly.
check_no_side_channels() {
  as_builder /usr/local/bin/node -e '
    const fs = require("fs"), net = require("net")
    const found = []
    try { fs.readdirSync("/.fly"); found.push("/.fly is readable") } catch {}
    if (fs.existsSync("/.fly/api")) found.push("/.fly/api exists")
    // /proc/net/unix: Num RefCount Protocol Flags Type St Inode Path. Flags 00010000 = listening.
    const listening = fs.readFileSync("/proc/net/unix", "utf8").trim().split("\n").slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c[7] && (parseInt(c[3], 16) & 0x10000))
      .map((c) => c[7])
    const tryOne = (p) => new Promise((done) => {
      const s = net.connect(p.startsWith("@") ? "\0" + p.slice(1) : p)
      const t = setTimeout(() => { s.destroy(); done() }, 2000)
      s.on("connect", () => { clearTimeout(t); found.push("socket " + p + " accepts builder"); s.destroy(); done() })
      s.on("error", () => { clearTimeout(t); done() })
    })
    Promise.all([...new Set(listening)].map(tryOne)).then(() => {
      for (const f of found) console.error("[scene-builder] side channel: " + f)
      process.exit(found.length ? 1 : 0)
    })
  '
}

# Lets runner read the build's output: removes every symlink, then opens up real files and directories builder owns
freeze_scene() {
  local dir=$1
  find "$dir" -mindepth 1 -type l -delete
  find "$dir" -user builder \( -type d -exec chmod 755 {} + -o -type f -exec chmod 644 {} + \)
}
