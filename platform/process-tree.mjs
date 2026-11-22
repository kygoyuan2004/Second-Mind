import { spawn } from 'node:child_process';

/** Children inherit the backend's Windows Job Object; never create a breakaway job. */
export function spawnHidden(command, args = [], options = {}) {
  return spawn(command, args, { ...options, windowsHide: true, shell: false });
}

/** Stop a single task and its subprocesses, including FFmpeg launched by yt-dlp. */
export async function terminateProcessTree(child, { force = true } = {}) {
  if (!child?.pid || child.exitCode !== null || child.signalCode) return;
  if (process.platform === 'win32') {
    await new Promise((resolve) => {
      const killer = spawnHidden(`${process.env.SystemRoot || 'C:\\Windows'}\\System32\\taskkill.exe`,
        ['/PID', String(child.pid), '/T', ...(force ? ['/F'] : [])], { stdio: 'ignore' });
      killer.once('error', () => { child.kill(); resolve(); });
      killer.once('close', resolve);
    });
  } else {
    // Media children are session leaders on POSIX, so a group signal also stops descendants.
    try { process.kill(-child.pid, force ? 'SIGKILL' : 'SIGTERM'); }
    catch { child.kill(force ? 'SIGKILL' : 'SIGTERM'); }
  }
}
