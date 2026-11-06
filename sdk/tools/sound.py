#!/usr/bin/env python3
"""
sound.py: prepares short sounds for orion.audio.sfx_load().

It does two things:

  1. converts any audio file to the format the device accepts, 48 kHz 16-bit
     WAV (needs ffmpeg);
  2. synthesizes a simple effect from scratch, with no ffmpeg.

The device mixes short sounds inside an interrupt, with no time to resample,
and the codec runs only at 48 kHz, so the conversion happens here, once.
Sounds are kept whole in memory: one second of mono is 192 kB in the app's
memory, because it is doubled to stereo on loading. sfx_load refuses sounds
longer than 5 seconds; play longer ones with play_file().

sound_library.py uses the synthesizer in this file to build the SDK's sound
library.

Examples
--------
    # a 45 ms rising "blip", like a brick breaking
    ./sound.py --tone 880 --slide 1320 --ms 45 blip.wav

    # a low thud for a lost life
    ./sound.py --tone 180 --slide 70 --ms 260 --wave square thud.wav

    # a short burst of noise for a wall hit
    ./sound.py --noise --ms 25 wall.wav

    # converting an existing file
    ./sound.py sample.mp3 sample.wav
"""
import argparse
import array
import math
import os
import shutil
import subprocess
import sys
import wave

RATE = 48000

# A sound that starts or stops abruptly clicks. Every segment gets a short
# attack and release.
ATTACK_MS = 3.0
RELEASE_MS = 2.0


def segment(wave="square", hz=440.0, hz_end=None, ms=60.0, vol=1.0,
            duty=0.5, vibrato=0.0, vibrato_hz=14.0, env="hit"):
    """One piece of sound; a list of segments makes an effect.

    wave       square | sine | triangle | saw | noise | metal_noise
    hz, hz_end linear glide (hz_end None = steady tone)
    duty       square only: 0.125 and 0.25 are the NES timbres
    env        hit | hold | fade | flat, see envelope()
    """
    return dict(wave=wave, hz=float(hz),
                hz_end=float(hz if hz_end is None else hz_end),
                ms=float(ms), vol=float(vol), duty=float(duty),
                vibrato=float(vibrato), vibrato_hz=float(vibrato_hz), env=env)


def envelope(i, n, kind):
    """Gain 0..1 for sample i of n."""
    attack = max(1, int(RATE * ATTACK_MS / 1000.0))
    a = min(1.0, i / attack)

    release = min(max(1, int(RATE * RELEASE_MS / 1000.0)), n)
    if i > (n - release):
        a *= (n - i) / release

    if kind == "hit":         # percussive, falls ~40 dB over the length
        return a * math.exp(-5.0 * i / n)
    if kind == "fade":        # linear, good for explosion noise
        return a * (1.0 - i / n)
    if kind == "hold":        # a note of a tune: full, with a short tail
        tail = max(1, int(n * 0.12))
        return a * min(1.0, (n - i) / tail)
    return a                  # "flat": only attack and release


class _Noise:
    """Linear congruential generator, so the same command always writes the
    same file."""

    def __init__(self, seed=0x13579BDF):
        self.s = seed

    def __call__(self):
        self.s = (self.s * 1103515245 + 12345) & 0xFFFFFFFF
        return ((self.s >> 16) & 0xFFFF) / 32768.0 - 1.0


def render(segments, vol=1.0):
    """Renders the segments in sequence: mono 48 kHz int16 samples."""
    out = array.array("h")
    noise = _Noise()
    phase = 0.0
    last = 0.0            # for metal_noise

    for sg in segments:
        n = max(1, int(RATE * sg["ms"] / 1000.0))

        for i in range(n):
            t = i / n
            hz = sg["hz"] + (sg["hz_end"] - sg["hz"]) * t
            if sg["vibrato"]:
                hz *= 1.0 + sg["vibrato"] * math.sin(
                    2.0 * math.pi * sg["vibrato_hz"] * i / RATE)

            w = sg["wave"]
            if w == "noise":
                v = noise()
            elif w == "metal_noise":
                # noise held in steps whose length follows the pitch: the
                # "tinny" noise of 8-bit sound chips
                step = max(1, int(RATE / max(1.0, hz)))
                if i % step == 0:
                    last = 1.0 if noise() > 0 else -1.0
                v = last
            else:
                phase += 2.0 * math.pi * hz / RATE
                if phase > 2.0 * math.pi:
                    phase -= 2.0 * math.pi
                if w == "square":
                    v = 1.0 if (phase / (2.0 * math.pi)) < sg["duty"] else -1.0
                elif w == "triangle":
                    v = 2.0 / math.pi * math.asin(
                        max(-1.0, min(1.0, math.sin(phase))))
                elif w == "saw":
                    v = 2.0 * (phase / (2.0 * math.pi)) - 1.0
                else:
                    v = math.sin(phase)

            g = envelope(i, n, sg["env"]) * sg["vol"] * vol
            out.append(int(max(-1.0, min(1.0, v * g)) * 32000))

    return out


def write_wav(path, samples):
    with wave.open(path, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(RATE)
        w.writeframes(samples.tobytes())
    return len(samples)


def summary(path, frames, stereo=False):
    kb = frames * 2 * (1 if stereo else 2) / 1024.0
    print("%-22s %5.0f ms %7.1f kB in memory"
          % (os.path.basename(path), frames / RATE * 1000.0, kb))
    if frames > 5 * RATE:
        print("  warning: over 5 seconds, sfx_load will refuse it", file=sys.stderr)


def convert(args):
    ff = shutil.which("ffmpeg")
    if ff is None:
        sys.exit("converting a file needs ffmpeg (synthesizing does not: see --tone)")

    cmd = [ff, "-v", "error", "-y", "-i", args.input,
           "-ar", str(RATE), "-ac", "2" if args.stereo else "1",
           "-c:a", "pcm_s16le"]
    if args.ms:
        cmd += ["-t", str(args.ms / 1000.0)]
    cmd += [args.output]
    subprocess.run(cmd, check=True)


def main():
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("input", nargs="?", help="file to convert (needs ffmpeg)")
    p.add_argument("output", help="the .wav to write")
    p.add_argument("--tone", metavar="HZ", type=float, default=0.0, help="Hz: synthesize instead of converting")
    p.add_argument("--slide", metavar="HZ", type=float, default=0.0, help="final Hz of the glide")
    p.add_argument("--ms", type=float, default=0.0, help="length in milliseconds")
    p.add_argument("--wave", choices=["sine", "square", "triangle", "saw"],
                   default="sine", help="timbre (default sine)")
    p.add_argument("--duty", type=float, default=0.5, help="square only: 0.125 and 0.25 are the NES timbres")
    p.add_argument("--noise", action="store_true", help="noise instead of a tone")
    p.add_argument("--volume", type=float, default=0.8, help="0..1")
    p.add_argument("--stereo", action="store_true", help="convert to two channels (default mono)")
    args = p.parse_args()

    if args.input is not None and (args.tone or args.noise):
        sys.exit("either convert a file or synthesize a tone, not both")

    if args.tone or args.noise:
        if not args.ms:
            args.ms = 60.0
        c = render([segment(wave="noise" if args.noise else args.wave,
                            hz=args.tone or 440.0, hz_end=args.slide or None,
                            ms=args.ms, vol=args.volume, duty=args.duty)])
        summary(args.output, write_wav(args.output, c))
    elif args.input is None:
        sys.exit("give a file to convert, or --tone/--noise")
    else:
        convert(args)
        with wave.open(args.output, "rb") as w:
            summary(args.output, w.getnframes(), args.stereo)


if __name__ == "__main__":
    main()
