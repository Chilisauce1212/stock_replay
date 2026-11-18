# 第 2 步：只填不交。往代码、数量框写入，读回软件自动带出的名称、价格、可买，再清空。不点「买入」
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
  [DllImport("user32.dll")] public static extern int GetDlgCtrlID(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessage(IntPtr h, uint m, IntPtr w, string l);
  public static string Text(IntPtr h) { var sb = new StringBuilder(512); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)512, sb, 2, 500, out r); return sb.ToString(); }
  public static void SetText(IntPtr h, string s) { SendMessage(h, 0x000C, IntPtr.Zero, s); }
  public static List<IntPtr> Tops() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Kids(IntPtr p) { var l = new List<IntPtr>(); EnumChildWindows(p, (h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@
$main = [W]::Tops() | Where-Object { $t = New-Object Text.StringBuilder 512; [void][W]::GetWindowText($_, $t, 512); $t.ToString() -like '网上股票交易系统*' } | Select-Object -First 1
if (-not $main) { "没找到下单窗口"; exit 1 }
$kids = [W]::Kids($main) | Where-Object { [W]::IsWindowVisible($_) }
# 买入面板：含「买入[B]」按钮（ID 1006）的那个 #32770
$panel = [W]::GetParent(($kids | Where-Object { [W]::GetDlgCtrlID($_) -eq 1006 } | Select-Object -First 1))
$ctl = @{}; foreach ($h in [W]::Kids($panel)) { if ([W]::GetParent($h) -eq $panel) { $ctl[[W]::GetDlgCtrlID($h)] = $h } }
$show = { param($label) "{0}: 代码[{1}] 名称[{2}] 价格[{3}] 可买[{4}] 数量[{5}]" -f $label, [W]::Text($ctl[1032]), [W]::Text($ctl[1036]), [W]::Text($ctl[1033]), [W]::Text($ctl[1018]), [W]::Text($ctl[1034]) }
& $show '填之前'
$sw = [Diagnostics.Stopwatch]::StartNew()
[W]::SetText($ctl[1032], '600000')
"写代码用时 $($sw.ElapsedMilliseconds) ms"
foreach ($i in 1..20) { Start-Sleep -Milliseconds 100; if ([W]::Text($ctl[1036])) { break } }
"名称带出用时 $($sw.ElapsedMilliseconds) ms"
[W]::SetText($ctl[1034], '100')
& $show '填之后'
Start-Sleep -Milliseconds 300
[W]::SetText($ctl[1034], ''); [W]::SetText($ctl[1033], ''); [W]::SetText($ctl[1032], '')
Start-Sleep -Milliseconds 300
& $show '清空后'
