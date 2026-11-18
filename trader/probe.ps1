# 只读探测：列出同花顺下单窗口的子控件（句柄、类名、控件 ID、文字、位置），不点击、不输入
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
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] public static extern IntPtr GetParent(IntPtr h);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr SendMessageTimeout(IntPtr h, uint m, IntPtr w, StringBuilder l, uint f, uint t, out IntPtr r);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  public static string Text(IntPtr h) { var sb = new StringBuilder(512); IntPtr r; SendMessageTimeout(h, 0x000D, (IntPtr)512, sb, 2, 500, out r); return sb.ToString(); }
  public static string Cls(IntPtr h) { var sb = new StringBuilder(256); GetClassName(h, sb, 256); return sb.ToString(); }
  public static List<IntPtr> Tops() { var l = new List<IntPtr>(); EnumWindows((h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
  public static List<IntPtr> Kids(IntPtr p) { var l = new List<IntPtr>(); EnumChildWindows(p, (h, x) => { l.Add(h); return true; }, IntPtr.Zero); return l; }
}
"@
$main = [W]::Tops() | Where-Object { $t = New-Object Text.StringBuilder 512; [void][W]::GetWindowText($_, $t, 512); $t.ToString() -like '网上股票交易系统*' } | Select-Object -First 1
if (-not $main) { "没找到「网上股票交易系统」窗口"; exit 1 }
"主窗口 句柄 $main 类名 $([W]::Cls($main))"
foreach ($h in [W]::Kids($main)) {
  if (-not [W]::IsWindowVisible($h)) { continue }
  $r = New-Object W+RECT; [void][W]::GetWindowRect($h, [ref]$r)
  $txt = [W]::Text($h) -replace "`r?`n", ' '
  if ($txt.Length -gt 30) { $txt = $txt.Substring(0, 30) + '…' }
  '{0,-9} 父 {1,-9} ID {2,-6} {3,-28} ({4},{5} {6}x{7}) {8}' -f $h, [W]::GetParent($h), [W]::GetDlgCtrlID($h), [W]::Cls($h), $r.L, $r.T, ($r.R-$r.L), ($r.B-$r.T), $txt
}
