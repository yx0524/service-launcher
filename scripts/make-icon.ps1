# 生成应用图标：assets/icon.ico / icon.png / icon-alert.png
# 设计：深色圆角徽章 + 蓝色描边 + 绿色播放三角（对应界面里的「启动」按钮）
# 用法：pwsh -File scripts\make-icon.ps1
param([string]$OutDir = (Join-Path $PSScriptRoot '..\assets'))

Add-Type -AssemblyName System.Drawing
$ErrorActionPreference = 'Stop'
$OutDir = [System.IO.Path]::GetFullPath($OutDir)
New-Item -ItemType Directory -Path $OutDir -Force | Out-Null

function New-RoundedPath([single]$x, [single]$y, [single]$w, [single]$h, [single]$r) {
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $r * 2
  $path.AddArc($x, $y, $d, $d, 180, 90)
  $path.AddArc($x + $w - $d, $y, $d, $d, 270, 90)
  $path.AddArc($x + $w - $d, $y + $h - $d, $d, $d, 0, 90)
  $path.AddArc($x, $y + $h - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-IconBitmap([int]$size, [string]$variant = 'normal') {
  $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality

  $s = [single]$size
  $inset = [single]($s * 0.045)
  $radius = [single]($s * 0.22)

  # 底色：深蓝灰渐变（与界面 gray-900/slate 同色系）
  $badge = New-RoundedPath $inset $inset ($s - 2 * $inset) ($s - 2 * $inset) $radius
  $bgTop = [System.Drawing.Color]::FromArgb(255, 38, 52, 73)
  $bgBottom = [System.Drawing.Color]::FromArgb(255, 9, 14, 26)
  $bgBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, 0)),
    (New-Object System.Drawing.PointF(0, $s)),
    $bgTop, $bgBottom)
  $g.FillPath($bgBrush, $badge)

  # 描边
  if ($variant -eq 'alert') { $ringColor = [System.Drawing.Color]::FromArgb(255, 239, 68, 68) }
  else { $ringColor = [System.Drawing.Color]::FromArgb(255, 59, 130, 246) }
  $ringWidth = [single][Math]::Max(1.0, $s * 0.042)
  $ringPath = New-RoundedPath ($inset + $ringWidth / 2) ($inset + $ringWidth / 2) ($s - 2 * $inset - $ringWidth) ($s - 2 * $inset - $ringWidth) ($radius * 0.9)
  $ringPen = New-Object System.Drawing.Pen($ringColor, $ringWidth)
  $ringPen.Alignment = [System.Drawing.Drawing2D.PenAlignment]::Center
  $g.DrawPath($ringPen, $ringPath)

  # 播放三角
  # 小尺寸把三角放大一点，否则 16px 下留白太多显得小气
  if ($size -le 24) {
    $left = [single]($s * 0.325); $right = [single]($s * 0.795)
    $top = [single]($s * 0.215); $bottom = [single]($s * 0.785)
  } else {
    $left = [single]($s * 0.370); $right = [single]($s * 0.760)
    $top = [single]($s * 0.258); $bottom = [single]($s * 0.742)
  }
  $points = @(
    (New-Object System.Drawing.PointF($left, $top)),
    (New-Object System.Drawing.PointF($left, $bottom)),
    (New-Object System.Drawing.PointF($right, [single]($s * 0.5)))
  )
  if ($variant -eq 'alert') {
    $triTop = [System.Drawing.Color]::FromArgb(255, 252, 165, 165)
    $triBottom = [System.Drawing.Color]::FromArgb(255, 220, 38, 38)
  } else {
    $triTop = [System.Drawing.Color]::FromArgb(255, 74, 222, 128)
    $triBottom = [System.Drawing.Color]::FromArgb(255, 21, 128, 61)
  }
  $triBrush = New-Object System.Drawing.Drawing2D.LinearGradientBrush(
    (New-Object System.Drawing.PointF(0, $top)),
    (New-Object System.Drawing.PointF(0, $bottom)),
    $triTop, $triBottom)
  $g.FillPolygon($triBrush, [System.Drawing.PointF[]]$points)

  # 大尺寸才加「运行中」状态点，小尺寸会糊成一团
  if ($size -ge 32) {
    $dotR = [single]($s * 0.105)
    $dotCx = [single]($s * 0.755)
    $dotCy = [single]($s * 0.755)
    $outline = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(255, 9, 14, 26))
    $g.FillEllipse($outline, $dotCx - $dotR * 1.42, $dotCy - $dotR * 1.42, $dotR * 2.84, $dotR * 2.84)
    $dotColor = if ($variant -eq 'alert') { [System.Drawing.Color]::FromArgb(255, 239, 68, 68) } else { [System.Drawing.Color]::FromArgb(255, 34, 197, 94) }
    $dotBrush = New-Object System.Drawing.SolidBrush $dotColor
    $g.FillEllipse($dotBrush, $dotCx - $dotR, $dotCy - $dotR, $dotR * 2, $dotR * 2)
    $dotBrush.Dispose(); $outline.Dispose()
  }

  $g.Dispose()
  $triBrush.Dispose(); $ringPen.Dispose(); $ringPath.Dispose()
  $bgBrush.Dispose(); $badge.Dispose()
  return $bmp
}

function ConvertTo-IcoEntry([System.Drawing.Bitmap]$bmp) {
  # 32bpp BGRA 位图数据（行序自下而上）+ 全 0 的 AND 掩码
  $w = $bmp.Width; $h = $bmp.Height
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $stride = $data.Stride
  $raw = New-Object byte[] ($stride * $h)
  [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $raw, 0, $raw.Length)
  $bmp.UnlockBits($data)

  $xor = New-Object byte[] ($w * $h * 4)
  for ($y = 0; $y -lt $h; $y++) {
    $srcRow = ($h - 1 - $y) * $stride
    $dstRow = $y * $w * 4
    [Array]::Copy($raw, $srcRow, $xor, $dstRow, $w * 4)
  }
  $maskStride = [int][Math]::Floor(($w + 31) / 32) * 4
  $and = New-Object byte[] ($maskStride * $h)

  $ms = New-Object System.IO.MemoryStream
  $bw = New-Object System.IO.BinaryWriter($ms)
  $bw.Write([uint32]40); $bw.Write([int32]$w); $bw.Write([int32]($h * 2))
  $bw.Write([uint16]1); $bw.Write([uint16]32); $bw.Write([uint32]0)
  $bw.Write([uint32]($xor.Length + $and.Length))
  $bw.Write([int32]0); $bw.Write([int32]0); $bw.Write([uint32]0); $bw.Write([uint32]0)
  $bw.Write($xor); $bw.Write($and)
  $bw.Flush()
  $bytes = $ms.ToArray()
  $bw.Dispose(); $ms.Dispose()
  return , $bytes
}

function ConvertTo-PngBytes([System.Drawing.Bitmap]$bmp) {
  $ms = New-Object System.IO.MemoryStream
  $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return , $bytes
}

function Write-Ico([string]$path, [int[]]$sizes) {
  $images = @()
  foreach ($size in $sizes) {
    $bmp = New-IconBitmap $size
    # 大尺寸用 PNG 压缩，小尺寸用传统 BMP（兼容性最好）
    if ($size -ge 128) { $entry = ConvertTo-PngBytes $bmp; $isPng = $true }
    else { $entry = ConvertTo-IcoEntry $bmp; $isPng = $false }
    $images += [pscustomobject]@{ Size = $size; Data = $entry; IsPng = $isPng }
    $bmp.Dispose()
  }

  $fs = [System.IO.File]::Create($path)
  $bw = New-Object System.IO.BinaryWriter($fs)
  $bw.Write([uint16]0); $bw.Write([uint16]1); $bw.Write([uint16]$images.Count)
  $offset = 6 + 16 * $images.Count
  foreach ($img in $images) {
    $dim = if ($img.Size -ge 256) { 0 } else { $img.Size }
    $bw.Write([byte]$dim); $bw.Write([byte]$dim); $bw.Write([byte]0); $bw.Write([byte]0)
    $bw.Write([uint16]1); $bw.Write([uint16]32)
    $bw.Write([uint32]$img.Data.Length); $bw.Write([uint32]$offset)
    $offset += $img.Data.Length
  }
  foreach ($img in $images) { $bw.Write($img.Data) }
  $bw.Flush(); $bw.Dispose(); $fs.Dispose()
  Write-Host ("  icon.ico  {0} 尺寸: {1}  体积 {2:N1} KB" -f $images.Count, ($sizes -join '/'), ((Get-Item $path).Length / 1KB))
}

Write-Host "生成图标到 $OutDir"
Write-Ico (Join-Path $OutDir 'icon.ico') @(16, 24, 32, 48, 64, 128, 256)

$png256 = New-IconBitmap 256
$png256.Save((Join-Path $OutDir 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$png256.Dispose()

$alert256 = New-IconBitmap 256 'alert'
$alert256.Save((Join-Path $OutDir 'icon-alert.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$alert256.Dispose()

# 托盘图标：Windows 托盘实际取 16~24px，给 32px 让它在 125%/150% 缩放下也清楚
$tray = New-IconBitmap 32
$tray.Save((Join-Path $OutDir 'tray.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$tray.Dispose()
$trayAlert = New-IconBitmap 32 'alert'
$trayAlert.Save((Join-Path $OutDir 'tray-alert.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$trayAlert.Dispose()

# 预览图：把 16/24/32/48/64 放大 6 倍排一行，用来肉眼检查小尺寸可读性
$previewSizes = @(16, 24, 32, 48, 64)
$scale = 6
$gap = 8
$pad = 10
$cellW = 64 * $scale
$totalW = $pad * 2 + ($cellW + $gap) * $previewSizes.Count
$totalH = $pad * 2 + $cellW
$preview = New-Object System.Drawing.Bitmap($totalW, $totalH, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$pg = [System.Drawing.Graphics]::FromImage($preview)
$pg.Clear([System.Drawing.Color]::FromArgb(255, 32, 36, 44))
$pg.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::NearestNeighbor
$pg.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::Half
$x = $pad
foreach ($size in $previewSizes) {
  $bmp = New-IconBitmap $size
  $side = $size * $scale
  $pg.DrawImage($bmp, $x, $pad, $side, $side)
  $bmp.Dispose()
  $x += $cellW + $gap
}
$pg.Dispose()
$preview.Save((Join-Path $OutDir 'preview.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$preview.Dispose()

Write-Host "  icon.png / icon-alert.png 已生成"
