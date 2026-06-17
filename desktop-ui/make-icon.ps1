Add-Type -AssemblyName System.Drawing

$src = "C:\Users\Heart.Sir\Downloads\8D3F823ADA0C45F225791A696B5CC19E.png"
$dst = "app.ico"

$img = [System.Drawing.Image]::FromFile($src)

# Create ICO with multiple sizes
$sizes = @(16, 32, 48, 64, 256)
$frames = @()

foreach ($sz in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap $sz $sz
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.DrawImage($img, 0, 0, $sz, $sz)
    $g.Dispose()
    $frames += $bmp
}

# Create ICO
$ms = New-Object System.IO.MemoryStream
$fw = New-Object System.IO.BinaryWriter $ms

# ICO header
$fw.Write([byte]0)  # reserved
$fw.Write([byte]0)
$fw.Write([byte]1)  # ICO type
$fw.Write([byte]0)
$fw.Write([int16]$frames.Count)  # number of images

$offset = 6 + $frames.Count * 16
$imageData = @()

foreach ($bmp in $frames) {
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $data = $ms.ToArray()
    $imageData += $data
    $ms.SetLength(0)
    $ms.Position = 0
    $bmp.Dispose()
}

$ms.Close()
$ms.Dispose()

# Create a new MemoryStream for the final ICO
$ms2 = New-Object System.IO.MemoryStream
$fw2 = New-Object System.IO.BinaryWriter $ms2

$fw2.Write([byte]0)
$fw2.Write([byte]0)
$fw2.Write([byte]1)
$fw2.Write([byte]0)
$fw2.Write([int16]$frames.Count)

$offset = 6 + $frames.Count * 16
$allData = New-Object System.Collections.ArrayList

for ($i = 0; $i -lt $sizes.Count; $i++) {
    $sz = $sizes[$i]
    $bmp2 = New-Object System.Drawing.Bitmap $sz $sz
    $g2 = [System.Drawing.Graphics]::FromImage($bmp2)
    $g2.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g2.DrawImage($img, 0, 0, $sz, $sz)
    $g2.Dispose()

    $pngMs = New-Object System.IO.MemoryStream
    $bmp2.Save($pngMs, [System.Drawing.Imaging.ImageFormat]::Png)
    $data = $pngMs.ToArray()
    $pngMs.Close()
    $bmp2.Dispose()

    [void]$allData.Add($data)
}

for ($i = 0; $i -lt $sizes.Count; $i++) {
    $w = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $h = if ($sizes[$i] -ge 256) { 0 } else { $sizes[$i] }
    $fw2.Write([byte]$w)      # width
    $fw2.Write([byte]$h)      # height
    $fw2.Write([byte]0)       # colors
    $fw2.Write([byte]0)       # reserved
    $fw2.Write([int16]1)      # planes
    $fw2.Write([int16]32)     # bits per pixel
    $fw2.Write([int32]$allData[$i].Length)  # size
    $fw2.Write([int32]$offset)  # offset
    $offset += $allData[$i].Length
}

foreach ($data in $allData) {
    $fw2.Write($data)
}

$fw2.Flush()
[System.IO.File]::WriteAllBytes((Join-Path (Get-Location) $dst), $ms2.ToArray())
$fw2.Close()
$ms2.Close()

Write-Host "ICO created: $dst"
$img.Dispose()
