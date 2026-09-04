#!/usr/bin/env bash

set -Eeuo pipefail

die() {
  printf 'Second Mind installer: %s\n' "$*" >&2
  exit 1
}

note() {
  printf '%s\n' "$*"
}

read_value() {
  local filename=$1 value=''
  [[ -f "$filename" ]] || die "Missing installer operation file: $filename"
  IFS= read -r value < "$filename" || [[ -n "$value" ]] || true
  printf '%s' "$value"
}

run_docker() {
  MSYS_NO_PATHCONV=1 docker "$@"
}

host_paths_are_separate() {
  local knowledge_path=$1 knowledge_real='' state_real=''
  knowledge_real=$(CDPATH= cd -- "$knowledge_path" 2>/dev/null && pwd -P) || {
    printf 'Knowledge-base path does not exist or is not accessible: %s\n' "$knowledge_path" >&2
    return 1
  }
  state_real=$(CDPATH= cd -- "$state_root" 2>/dev/null && pwd -P) || return 1
  if [[ $knowledge_real == "$state_real"
        || $knowledge_real == /
        || $state_real == /
        || $knowledge_real == "$state_real/"*
        || $state_real == "$knowledge_real/"* ]]; then
    printf 'Knowledge-base and installer state paths must not contain one another after resolving links.\n' >&2
    return 1
  fi
}

probe_knowledge_base_path() {
  local knowledge_path=$1
  note 'Checking knowledge-base access from Docker...'
  run_docker run --rm \
    --user "$runtime_uid:$runtime_gid" \
    --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
    --mount "type=bind,source=$knowledge_path,target=/probe" \
    "$installer_image" \
    node /workspace/scripts/install.mjs internal-probe-vault --source /probe
}

admin_password_provided=false
admin_password_input=''
if [[ ${SECOND_MIND_ADMIN_PASSWORD+x} ]]; then
  admin_password_provided=true
  admin_password_input=$SECOND_MIND_ADMIN_PASSWORD
  unset SECOND_MIND_ADMIN_PASSWORD
fi

script_dir=$(CDPATH= cd -- "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)
repo_root=$script_dir
case "$(uname -s)" in
  Darwin*)
    host_os=darwin
    default_state_root=${HOME:?HOME is required}/Library/Application\ Support/Second\ Mind
    ;;
  Linux*)
    host_os=linux
    default_state_root=${XDG_CONFIG_HOME:-${HOME:?HOME is required}/.config}/second-mind
    ;;
  *) die 'Use install.ps1 on Windows, or run this script from Linux/macOS.' ;;
esac

state_root=${SECOND_MIND_CONFIG_HOME:-$default_state_root}
mkdir -p -- "$state_root"
state_root=$(CDPATH= cd -- "$state_root" && pwd -P)
installer_image=${SECOND_MIND_INSTALLER_IMAGE:-node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5}
runtime_uid=$(id -u)
runtime_gid=$(id -g)

command_name=init
if (($# > 0)) && [[ $1 != --* ]]; then command_name=$1; fi
case "$command_name" in
  init|doctor|status|logs|update|backup) ;;
  *) die "Unsupported command: $command_name" ;;
esac

command -v docker >/dev/null 2>&1 || die 'Docker is not installed or is not on PATH.'
run_docker version >/dev/null 2>&1 || die 'Docker Engine is not reachable. Start Docker Desktop or the Docker service.'
run_docker compose version >/dev/null 2>&1 || die 'Docker Compose v2 (docker compose) is required.'

terminal=(-i)
non_interactive=false
for argument in "$@"; do
  [[ $argument == --non-interactive ]] && non_interactive=true
done
if [[ $command_name == init && $non_interactive == false && -t 0 && -t 1 ]]; then
  terminal=(-it)
fi

installer_options=("$@")
if (($# > 0)) && [[ $1 != --* ]]; then installer_options=("${@:2}"); fi
installer_context_arguments=(
  --repo-root /workspace \
  --state-root /state \
  --host-os "$host_os" \
  --host-repo-root "$repo_root" \
  --host-state-root "$state_root" \
  --host-home "${HOME:-}" \
  --runtime-uid "$runtime_uid" \
  --runtime-gid "$runtime_gid")

run_installer_preflight() {
  run_docker run --rm \
    --user "$runtime_uid:$runtime_gid" \
    --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
    --mount "type=bind,source=$state_root,target=/state,readonly" \
    "$installer_image" \
    node /workspace/scripts/install.mjs internal-preflight \
    "${installer_options[@]}" \
    --operation "$command_name" \
    "${installer_context_arguments[@]}"
}

preflight_result=$(run_installer_preflight)
if [[ $preflight_result == VAULT_REQUIRED ]]; then
  [[ $non_interactive == false ]] \
    || die 'A new non-interactive installation requires --vault PATH.'
  [[ -t 0 && -t 1 ]] \
    || die 'A new installation requires a terminal for the Vault prompt, or use --vault PATH.'
  vault_input=''
  IFS= read -r -p 'Vault or knowledge-base parent path: ' vault_input \
    || die 'Unable to read the Vault path.'
  installer_options+=(--vault "$vault_input")
  preflight_result=$(run_installer_preflight)
fi
[[ $preflight_result == VAULT_PATH=* ]] \
  || die 'Installer preflight returned an invalid response.'
knowledge_base=${preflight_result#VAULT_PATH=}
[[ -n $knowledge_base ]] || die 'Installer preflight returned an empty knowledge-base path.'
host_paths_are_separate "$knowledge_base" \
  || die 'Installer state and knowledge-base paths are not safely separated.'
if [[ $command_name == init ]]; then probe_knowledge_base_path "$knowledge_base"; fi

installer_arguments=("$command_name" "${installer_options[@]}" --expected-vault "$knowledge_base")
password_stdin=false
if [[ $command_name == init && $non_interactive == true && $admin_password_provided == true ]]; then
  password_stdin=true
  installer_arguments+=(--admin-password-stdin)
fi

installer_docker_arguments=(run --rm "${terminal[@]}"
  --user "$runtime_uid:$runtime_gid" \
  --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
  --mount "type=bind,source=$state_root,target=/state" \
  "$installer_image" \
  node /workspace/scripts/install.mjs "${installer_arguments[@]}" \
  "${installer_context_arguments[@]}")

if [[ $password_stdin == true ]]; then
  printf '%s' "$admin_password_input" | run_docker "${installer_docker_arguments[@]}"
  admin_password_input=''
else
  run_docker "${installer_docker_arguments[@]}"
fi

instance_id=$(read_value "$state_root/current")
[[ $instance_id =~ ^second-mind-[a-z0-9][a-z0-9-]{5,48}[a-z0-9]$ ]] \
  || die 'Installer returned an invalid instance identifier.'
instance_root=$state_root/$instance_id
operation_root=$instance_root/operation
project=$(read_value "$operation_root/project")
volume=$(read_value "$operation_root/volume")
port=$(read_value "$operation_root/port")
configured_knowledge_base=$(read_value "$operation_root/vault")
[[ $configured_knowledge_base == "$knowledge_base" ]] \
  || die 'Installer state changed after the read-only preflight.'
knowledge_base=$configured_knowledge_base
runtime_uid=$(read_value "$operation_root/runtimeUid")
runtime_gid=$(read_value "$operation_root/runtimeGid")

compose=(
  docker compose
  --project-name "$project"
  --env-file "$instance_root/.env"
  -f "$repo_root/compose.yaml"
  -f "$repo_root/compose.secrets.yaml"
  -f "$instance_root/compose.instance.yaml"
)

run_compose() {
  MSYS_NO_PATHCONV=1 "${compose[@]}" "$@"
}

compose_running() {
  [[ -n "$(run_compose ps --status running -q app 2>/dev/null)" ]]
}

compose_owns_port() {
  compose_running || return 1
  local binding=''
  binding=$(run_compose port app 8787 2>/dev/null) || return 1
  [[ $binding =~ :${port}$ ]]
}

check_compose() {
  run_compose config --quiet
}

probe_knowledge_base() {
  host_paths_are_separate "$knowledge_base" || return 1
  probe_knowledge_base_path "$knowledge_base"
}

probe_port() {
  if compose_owns_port; then
    note "Port $port is already owned by this running Second Mind instance."
    return 0
  fi
  note "Checking whether 127.0.0.1:$port is available..."
  run_docker run --rm \
    --publish "127.0.0.1:$port:8787" \
    "$installer_image" \
    node -e 'setTimeout(() => {}, 250)' \
    >/dev/null 2>&1
}

prepare_volume() {
  run_docker volume create "$volume" >/dev/null
  run_docker run --rm \
    --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
    --mount "type=volume,source=$volume,target=/runtime-data" \
    "$installer_image" \
    node /workspace/scripts/install.mjs internal-own-tree \
    --source /runtime-data --output-uid "$runtime_uid" --output-gid "$runtime_gid" \
    >/dev/null
}

prepare_application_image() {
  local configured_image=''
  configured_image=$(run_compose config --images | head -n 1)
  if [[ $configured_image == *:local ]]; then
    run_compose build --pull app
    return
  fi
  if ! run_compose pull app; then
    note 'No pullable application image was available; rebuilding from the checked-out source.'
    run_compose build --pull app
  fi
}

probe_volume() {
  run_docker volume inspect "$volume" >/dev/null 2>&1 || return 1
  run_docker run --rm \
    --user "$runtime_uid:$runtime_gid" \
    --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
    --mount "type=volume,source=$volume,target=/probe" \
    "$installer_image" \
    node /workspace/scripts/install.mjs internal-probe-path --source /probe
}

health_once() {
  run_compose exec -T app node -e \
    "Promise.all(['/health/live','/health/ready'].map(async p=>{const r=await fetch('http://127.0.0.1:8787'+p,{signal:AbortSignal.timeout(5000)});if(!r.ok)throw new Error(p+' returned '+r.status)})).catch(e=>{console.error(e.message);process.exit(1)})"
}

wait_until_ready() {
  note 'Waiting for Second Mind readiness...'
  local deadline=$((SECONDS + 120))
  while ((SECONDS < deadline)); do
    if health_once >/dev/null 2>&1; then
      note "Second Mind is ready at http://127.0.0.1:$port"
      return 0
    fi
    sleep 2
  done
  run_compose ps
  die 'The app did not become ready within two minutes. Run ./install.sh logs --no-follow for details.'
}

check_pdf_runtime() {
  run_compose exec -T app node -e \
    "const fs=require('node:fs');const required=['/usr/bin/bwrap','/usr/bin/pdftotext'];const missing=required.filter(p=>{try{fs.accessSync(p,fs.constants.X_OK);return false}catch{return true}});const enabled=/^(1|true|yes|on)$/i.test(process.env.PDF_ENABLED||'');console.log('PDF sandbox: '+(missing.length?'unavailable ('+missing.join(', ')+')':'available')+(enabled?' [enabled]':' [disabled]'));if(enabled&&missing.length)process.exit(1)"
}

run_doctor() {
  local failures=0
  note 'Docker CLI and Engine versions:'
  run_docker version --format '  client={{.Client.Version}} server={{.Server.Version}}' \
    || failures=$((failures + 1))
  note 'Docker Compose version:'
  run_docker compose version || failures=$((failures + 1))
  note 'Docker Engine:'
  run_docker info --format '  version={{.ServerVersion}} os={{.OSType}} arch={{.Architecture}} cpus={{.NCPU}} memory={{.MemTotal}}' \
    || failures=$((failures + 1))
  if [[ $(run_docker info --format '{{.OSType}}' 2>/dev/null) != linux ]]; then
    printf '  Docker must be switched to Linux containers.\n' >&2
    failures=$((failures + 1))
  fi
  check_compose || failures=$((failures + 1))
  probe_knowledge_base || failures=$((failures + 1))
  if ! probe_volume; then
    printf 'Runtime volume %s is missing or not writable by UID:GID %s:%s.\n' "$volume" "$runtime_uid" "$runtime_gid" >&2
    failures=$((failures + 1))
  fi
  if ! probe_port; then
    printf 'Port %s is unavailable; no existing process was stopped.\n' "$port" >&2
    failures=$((failures + 1))
  fi
  note 'Docker disk usage:'
  run_docker system df || failures=$((failures + 1))
  if compose_running; then
    health_once || failures=$((failures + 1))
    check_pdf_runtime || failures=$((failures + 1))
  else
    note 'App health/PDF checks skipped because this instance is not running.'
  fi
  ((failures == 0)) || die "Doctor found $failures problem(s)."
  note 'Doctor checks passed.'
}

copy_backup_component() {
  local source_mount=$1 destination=$2
  run_docker run --rm \
    --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
    --mount "$source_mount" \
    --mount "type=bind,source=$backup_path,target=/backup" \
    "$installer_image" \
    node /workspace/scripts/install.mjs internal-copy-tree \
    --source /source --destination "/backup/$destination" \
    --output-uid "$runtime_uid" --output-gid "$runtime_gid" \
    >/dev/null
}

case "$command_name" in
  init)
    check_compose
    probe_port || die "Port $port is unavailable; no existing process was stopped. Choose another with: ./install.sh init --port PORT"
    prepare_volume
    prepare_application_image
    run_compose up -d --no-build --remove-orphans
    wait_until_ready
    ;;
  doctor)
    run_doctor
    ;;
  status)
    check_compose
    run_compose ps
    if compose_running; then
      health_once
      check_pdf_runtime
    fi
    ;;
  logs)
    tail_count=$(read_value "$operation_root/tail")
    follow=$(read_value "$operation_root/follow")
    log_arguments=(logs --tail "$tail_count")
    [[ $follow == true ]] && log_arguments+=(--follow)
    run_compose "${log_arguments[@]}"
    ;;
  update)
    check_compose
    probe_knowledge_base
    probe_port || die "Port $port is unavailable; no existing process was stopped. Choose another with: ./install.sh init --port PORT"
    prepare_volume
    prepare_application_image
    run_compose up -d --no-build --remove-orphans
    wait_until_ready
    ;;
  backup)
    backup_path=$(read_value "$operation_root/backup")
    backup_name=$(read_value "$operation_root/backupName")
    [[ $backup_name =~ ^[0-9TZ-]+-[a-f0-9]{6}$ ]] || die 'Installer returned an invalid backup identifier.'
    host_paths_are_separate "$knowledge_base" || die 'Backup refused because the source overlaps installer state.'
    run_docker volume inspect "$volume" >/dev/null 2>&1 || die "Runtime volume $volume does not exist."
    note 'Creating a live backup. Pause external Vault sync first if a point-in-time snapshot is required.'
    copy_backup_component "type=volume,source=$volume,target=/source,readonly" data
    copy_backup_component "type=bind,source=$knowledge_base,target=/source,readonly" vault
    run_docker run --rm \
      --user "$runtime_uid:$runtime_gid" \
      --mount "type=bind,source=$repo_root,target=/workspace,readonly" \
      --mount "type=bind,source=$state_root,target=/state" \
      "$installer_image" \
      node /workspace/scripts/install.mjs internal-finalize-backup \
      --backup-root "/state/$instance_id/backups/$backup_name" \
      >/dev/null
    note "Backup complete: $backup_path"
    ;;
esac
