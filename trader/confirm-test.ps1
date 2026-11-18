# 第 3 步（一）：填 600000 / 9.80 / 100，点「买入[B]」，然后只读出弹出的对话框内容，不点对话框里的任何按钮
Add-Type @"
using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public class W {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumChildWindows(IntPtr p, EnumProc f, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint p);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h, uint m, IntPtr w, IntPtr l);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  public static string Text(IntPtr h) { var sb = new StringBuilder(1024); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)1024, sb, 2, 500, out r); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static void SetText(IntPtr h, string s) { SendMessage(h, 0x000C, IntPtr.Zero, s); }
  public static uint Pid(IntPtr h) { uint p; GetWindowThreadProcessId(h, out p); return p; }
  public static List<IntPtr> Tops() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Kids(IntPtr p) { var l = new List<IntPtr>(); EnumChildWindows(p, (h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@
$main = [W]::Tops() | Where-Object { $t = New-Object Text.StringBuilder 512; [void][W]::GetWindowText($_, $t, 512); $t.ToString() -like '网上股票交易系统*' } | Select-Object -First 1
$pid0 = [W]::Pid($main)
$popups = { [W]::Tops() | Where-Object { [W]::Pid($_) -eq $pid0 -and $_ -ne $main -and [W]::IsWindowVisible($_) } }
$dump = { param($d) "== 弹窗 $d 标题 [$([W]::Text($d))]"; foreach ($h in [W]::Kids($d)) { if ([W]::IsWindowVisible($h)) { '   ID {0,-6} {1,-14} {2}' -f [W]::GetDlgCtrlID($h), [W]::Cls($h), ([W]::Text($h) -replace "`r?`n", ' / ') } } }
# 找「委托确认」框，点「是」（ID 6）
$confirm = @(& $popups) | Where-Object { [W]::Kids($_) | Where-Object { [W]::Text($_) -eq '委托确认' } } | Select-Object -First 1
if (-not $confirm) { "没找到委托确认框"; exit 1 }
$yes = [W]::Kids($confirm) | Where-Object { [W]::GetDlgCtrlID($_) -eq 6 } | Select-Object -First 1
$sw = [Diagnostics.Stopwatch]::StartNew()
[void][W]::PostMessage($yes, 0x00F5, [IntPtr]::Zero, [IntPtr]::Zero)
$new = @()
foreach ($i in 1..50) { Start-Sleep -Milliseconds 100; $new = @(& $popups | Where-Object { $_ -ne $confirm }); if ($new.Count) { break } }
"点「是」后 {0} ms，新弹窗 {1} 个" -f $sw.ElapsedMilliseconds, $new.Count
Start-Sleep -Milliseconds 300
foreach ($d in $new) { & $dump $d }
