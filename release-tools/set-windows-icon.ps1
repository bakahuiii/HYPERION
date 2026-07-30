[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$Executable,

  [Parameter(Mandatory = $true)]
  [string]$Icon
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$executablePath = (Resolve-Path -LiteralPath $Executable).Path
$iconPath = (Resolve-Path -LiteralPath $Icon).Path
$iconBytes = [System.IO.File]::ReadAllBytes($iconPath)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class TheiaResourceUpdater
{
    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    public static extern IntPtr BeginUpdateResource(string fileName, bool deleteExistingResources);

    [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool UpdateResource(
        IntPtr updateHandle,
        IntPtr resourceType,
        IntPtr resourceName,
        ushort language,
        byte[] data,
        uint dataSize
    );

    [DllImport("kernel32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    public static extern bool EndUpdateResource(IntPtr updateHandle, bool discard);
}
"@

$readerStream = [System.IO.MemoryStream]::new($iconBytes, $false)
$reader = [System.IO.BinaryReader]::new($readerStream)
try {
  $reserved = $reader.ReadUInt16()
  $type = $reader.ReadUInt16()
  $count = $reader.ReadUInt16()
  if ($reserved -ne 0 -or $type -ne 1 -or $count -lt 1) {
    throw "Invalid ICO header: $iconPath"
  }

  $entries = for ($index = 0; $index -lt $count; $index += 1) {
    [pscustomobject]@{
      Width = $reader.ReadByte()
      Height = $reader.ReadByte()
      ColorCount = $reader.ReadByte()
      Reserved = $reader.ReadByte()
      Planes = $reader.ReadUInt16()
      BitCount = $reader.ReadUInt16()
      BytesInResource = $reader.ReadUInt32()
      ImageOffset = $reader.ReadUInt32()
      ResourceId = 1 + $index
    }
  }
} finally {
  $reader.Dispose()
  $readerStream.Dispose()
}

$groupStream = [System.IO.MemoryStream]::new()
$groupWriter = [System.IO.BinaryWriter]::new($groupStream)
try {
  $groupWriter.Write([uint16]0)
  $groupWriter.Write([uint16]1)
  $groupWriter.Write([uint16]$entries.Count)
  foreach ($entry in $entries) {
    $groupWriter.Write([byte]$entry.Width)
    $groupWriter.Write([byte]$entry.Height)
    $groupWriter.Write([byte]$entry.ColorCount)
    $groupWriter.Write([byte]$entry.Reserved)
    $groupWriter.Write([uint16]$entry.Planes)
    $groupWriter.Write([uint16]$entry.BitCount)
    $groupWriter.Write([uint32]$entry.BytesInResource)
    $groupWriter.Write([uint16]$entry.ResourceId)
  }
  $groupWriter.Flush()
  $groupBytes = $groupStream.ToArray()
} finally {
  $groupWriter.Dispose()
  $groupStream.Dispose()
}

$updateHandle = [TheiaResourceUpdater]::BeginUpdateResource($executablePath, $false)
if ($updateHandle -eq [IntPtr]::Zero) {
  throw "BeginUpdateResource failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
}

$committed = $false
try {
  foreach ($entry in $entries) {
    $endOffset = [uint64]$entry.ImageOffset + [uint64]$entry.BytesInResource
    if ($endOffset -gt $iconBytes.Length) {
      throw "ICO image entry extends past the end of the file: $iconPath"
    }
    $imageBytes = [byte[]]::new([int]$entry.BytesInResource)
    [Array]::Copy($iconBytes, [int]$entry.ImageOffset, $imageBytes, 0, $imageBytes.Length)
    $updated = [TheiaResourceUpdater]::UpdateResource(
      $updateHandle,
      [IntPtr]3,
      [IntPtr]$entry.ResourceId,
      [uint16]0,
      $imageBytes,
      [uint32]$imageBytes.Length
    )
    if (-not $updated) {
      throw "Updating RT_ICON failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
    }
  }

  $groupUpdated = [TheiaResourceUpdater]::UpdateResource(
    $updateHandle,
    [IntPtr]14,
    [IntPtr]1,
    [uint16]0,
    $groupBytes,
    [uint32]$groupBytes.Length
  )
  if (-not $groupUpdated) {
    throw "Updating RT_GROUP_ICON failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }

  if (-not [TheiaResourceUpdater]::EndUpdateResource($updateHandle, $false)) {
    throw "EndUpdateResource failed with Win32 error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())"
  }
  $committed = $true
} finally {
  if (-not $committed) {
    [void][TheiaResourceUpdater]::EndUpdateResource($updateHandle, $true)
  }
}

Write-Host "Embedded $($entries.Count) icon sizes into $executablePath"
