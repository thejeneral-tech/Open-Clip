param(
  [Parameter(Mandatory=$true)][string]$TextFile,
  [Parameter(Mandatory=$true)][string]$Out,
  [string]$Voice = "",
  [int]$Rate = 0,
  [int]$Volume = 100,
  [string]$TimingsOut = ""
)
# Local Windows SAPI narration. Emits a real word-boundary timing track (via the
# SpeakProgress event) so captions can be synchronised to the audio precisely.
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Speech
$text = Get-Content -Raw -Encoding UTF8 $TextFile
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
if ($Voice -ne "") { try { $synth.SelectVoice($Voice) } catch { } }
$synth.Rate = [Math]::Max(-10, [Math]::Min(10, $Rate))
$synth.Volume = [Math]::Max(0, [Math]::Min(100, $Volume))

$timings = New-Object System.Collections.ArrayList
$handler = {
  param($s, $e)
  [void]$timings.Add([pscustomobject]@{
    audioMs   = [int]$e.AudioPosition.TotalMilliseconds
    charPos   = [int]$e.CharacterPosition
    charCount = [int]$e.CharacterCount
    word      = $e.Text
  })
}
$synth.add_SpeakProgress($handler)
$synth.SetOutputToWaveFile($Out)
$synth.Speak($text)
$synth.SetOutputToNull()
$synth.Dispose()

if ($TimingsOut -ne "") {
  if ($timings.Count -eq 0) { "[]" | Out-File -Encoding UTF8 $TimingsOut }
  else { ConvertTo-Json -Compress -InputObject @($timings) | Out-File -Encoding UTF8 $TimingsOut }
}
Write-Output "OK $($timings.Count)"
