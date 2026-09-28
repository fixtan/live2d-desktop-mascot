const { spawn } = require('child_process');

// 常駐させて200msごとにVS Codeの矩形を出力するPowerShell
const PS_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left, Top, Right, Bottom; }
public static class W {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindow(IntPtr h);
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int s);
}
"@
[W]::SetProcessDpiAwarenessContext([IntPtr](-4)) | Out-Null
$h = [IntPtr]::Zero
while ($true) {
  if ($h -eq [IntPtr]::Zero -or -not [W]::IsWindow($h)) {
    $p = Get-Process -Name Code -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1
    if ($p) { $h = $p.MainWindowHandle } else { $h = [IntPtr]::Zero }
  }
  if ($h -ne [IntPtr]::Zero -and -not [W]::IsIconic($h)) {
    $r = New-Object RECT
    [W]::DwmGetWindowAttribute($h, 9, [ref]$r, 16) | Out-Null
    [Console]::Out.WriteLine("$($r.Left),$($r.Top),$($r.Right - $r.Left),$($r.Bottom - $r.Top)")
  } else {
    [Console]::Out.WriteLine("none")
  }
  [Console]::Out.Flush()
  Start-Sleep -Milliseconds 200
}
`;

function start(onRect) {
  const encoded = Buffer.from(PS_SCRIPT, 'utf16le').toString('base64');
  const proc = spawn('powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded],
    { windowsHide: true });

  let buf = '';
  proc.stdout.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    const last = lines.filter(Boolean).pop();
    if (!last) return;

    if (last === 'none') { onRect(null); return; }

    const [x, y, width, height] = last.split(',').map(Number);
    if ([x, y, width, height].some(Number.isNaN) || width <= 0 || height <= 0) return;
    onRect({ x, y, width, height });
  });

  proc.stderr.on('data', (d) => {
    const s = d.toString();
    if (s.startsWith('#< CLIXML') || s.includes('<Objs ')) return; // PowerShellの進捗ノイズ
    console.error('[tracker]', s);
  });

  return { stop: () => proc.kill() };
}

module.exports = { start, supported: true };
