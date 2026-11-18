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
# 只读：列出下单程序所有可见弹窗及其全部子控件（含不可见的）
$main = [W]::Tops() | Where-Object { $t = New-Object Text.StringBuilder 512; [void][W]::GetWindowText($_, $t, 512); $t.ToString() -like '网上股票交易系统*' } | Select-Object -First 1
$pid0 = [W]::Pid($main)
foreach ($d in [W]::Tops()) {
  if ([W]::Pid($d) -ne $pid0 -or $d -eq $main -or -not [W]::IsWindowVisible($d)) { continue }
  "== 弹窗 $d 类名 $([W]::Cls($d)) 标题 [$([W]::Text($d))]"
  foreach ($h in [W]::Kids($d)) { '   ID {0,-6} {1,-14} 可见 {2,-5} {3}' -f [W]::GetDlgCtrlID($h), [W]::Cls($h), [W]::IsWindowVisible($h), ([W]::Text($h) -replace "`r?`n", ' / ') }
}
