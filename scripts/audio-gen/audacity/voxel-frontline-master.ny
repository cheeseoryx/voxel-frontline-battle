;nyquist plug-in
;version 4
;type process
;name "Voxel Frontline Master"
;action "Filtering and limiting..."
;author "Voxel Frontline project"
;release 2
;copyright "Project-original procedural workflow"

; Manual polish for physically-modeled SFX (not chip-style):
; 1. Select the full mono track.
; 2. Run this effect.
; 3. Export mono 44.1 kHz WAV, or OGG Vorbis q5 when FFmpeg is configured.
; Keep sub-20–80 Hz energy for muzzle/explosion thump. Do not hard-clip.

(setf cleaned (highpass8 (lowpass8 *track* 16000) 18))
(setf duration (get-duration 1))
(setf shaped
  (mult cleaned
    (pwlv 0
          0.004 1
          (max 0.005 (- duration 0.010)) 1
          duration 0)))
(setf pk (peak shaped ny:all))
(if (> pk 0.0001)
    (mult shaped (/ 0.82 pk))
    shaped)
