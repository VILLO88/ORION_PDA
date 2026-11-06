#!/usr/bin/env python3
"""
sound_library.py: the sound effects that come with the SDK.

    ./sound_library.py           writes them all to ../sounds/
    ./sound_library.py coin      only that one
    ./sound_library.py --check   tells whether the .wav files in the repo are
                                 the ones these recipes produce

The sounds are synthesized (square waves, stepped noise, fast glides: what
8-bit sound chips could do), so they carry nobody's rights and can be used,
changed and shared with any app. The synthesizer is in sound.py; this file
only has the recipes.

On the card they go in /sounds, which an app sees as shared/sounds/:

    local blip = orion.audio.sfx_load("shared/sounds/coin.wav")
"""
import os
import sys
import wave

from sound import RATE, render, write_wav, segment, summary

S = segment

# Half of full scale: the firmware adds up to four voices with saturation,
# and two square waves at full scale would clip. To make one effect louder,
# raise its volume in sfx_play().
LEVEL = 0.5

# Notes in Hz.
C4, D4, E4, F4, G4, A4, B4 = 262, 294, 330, 349, 392, 440, 494
C5, D5, E5, F5, G5, A5, B5 = 523, 587, 659, 698, 784, 880, 988
C6, D6, E6, G6, A6 = 1047, 1175, 1319, 1568, 1760

# What each one is for; also used to write sounds/README.md.
USED_FOR = {
    "coin": "collecting something worth points",
    "powerup": "a new weapon, a shield, a key",
    "extra_life": "more important than a power-up, and it sounds it",
    "pickup": "any item, short and discreet",
    "jump": "the classic jump, rising fast",
    "land": "back on the ground",
    "bounce": "a ball, a spring",
    "step": "a step, a muffled thud, a knock against a wall",
    "laser": "an energy shot, falling fast",
    "shoot": "a normal bullet: tone plus noise",
    "explosion": "an enemy blowing up, or the player",
    "hit": "taking a hit without dying",
    "brick": "a block breaking",
    "shield": "protection on: a steady, wavering tone",
    "error": "move not allowed, life lost",
    "game_over": "four falling notes",
    "victory": "level complete",
    "alarm": "time running out, danger",
    "select": "moving in a menu",
    "confirm": "ENTER",
    "cancel": "ESC",
}

RECIPES = {
    # ---- collecting and rewards
    # a short note and a long one a fifth above
    "coin": [S("square", B5, ms=60, duty=0.25, env="hold"),
             S("square", E6, ms=240, duty=0.25, vol=0.9)],

    "powerup": [S("square", C5, ms=45, duty=0.25, env="hold"),
                S("square", E5, ms=45, duty=0.25, env="hold"),
                S("square", G5, ms=45, duty=0.25, env="hold"),
                S("square", C6, ms=180, duty=0.25)],

    # the same arpeggio, higher and longer than a power-up
    "extra_life": [S("square", E5, ms=55, duty=0.5, env="hold"),
                   S("square", G5, ms=55, duty=0.5, env="hold"),
                   S("square", C6, ms=55, duty=0.5, env="hold"),
                   S("square", E6, ms=55, duty=0.5, env="hold"),
                   S("square", G6, ms=260, duty=0.5)],

    "pickup": [S("square", A5, A6, ms=70, duty=0.125)],

    # ---- movement
    "jump": [S("square", 330, 1100, ms=130, duty=0.5, env="hit")],
    "land": [S("square", 500, 160, ms=90, duty=0.5)],
    "bounce": [S("triangle", 400, 900, ms=55)],
    "step": [S("noise", ms=35, vol=0.5, env="fade")],

    # ---- combat
    "laser": [S("saw", 1800, 220, ms=160, vol=0.8)],
    "shoot": [S("square", 900, 300, ms=70, duty=0.125),
              S("noise", ms=50, vol=0.6, env="fade")],
    "explosion": [S("metal_noise", 2200, 300, ms=420, env="fade")],
    "hit": [S("metal_noise", 1400, 500, ms=110, env="hit"),
            S("square", 200, 90, ms=90, duty=0.5, vol=0.7)],
    "brick": [S("square", 880, 1500, ms=45, duty=0.25)],
    "shield": [S("square", 700, 700, ms=180, duty=0.5, vibrato=0.06,
                 vibrato_hz=28)],

    # ---- mistakes and endings
    "error": [S("square", 200, ms=90, duty=0.5, env="hold"),
              S("square", 150, ms=200, duty=0.5)],

    "game_over": [S("square", G4, ms=160, duty=0.5, env="hold"),
                  S("square", F4, ms=160, duty=0.5, env="hold"),
                  S("square", E4, ms=160, duty=0.5, env="hold"),
                  S("square", C4, ms=480, duty=0.5)],

    "victory": [S("square", C5, ms=90, duty=0.5, env="hold"),
                S("square", E5, ms=90, duty=0.5, env="hold"),
                S("square", G5, ms=90, duty=0.5, env="hold"),
                S("square", C6, ms=90, duty=0.5, env="hold"),
                S("square", G5, ms=90, duty=0.5, env="hold"),
                S("square", C6, ms=420, duty=0.5)],

    "alarm": [S("square", 880, ms=120, duty=0.5, env="hold"),
              S("square", 660, ms=120, duty=0.5, env="hold"),
              S("square", 880, ms=120, duty=0.5, env="hold"),
              S("square", 660, ms=200, duty=0.5)],

    # ---- menus: short, they play on every key press
    "select": [S("square", 1200, ms=25, duty=0.25, vol=0.6)],
    "confirm": [S("square", 800, ms=45, duty=0.25, env="hold"),
                S("square", 1200, ms=90, duty=0.25)],
    "cancel": [S("square", 700, ms=45, duty=0.25, env="hold"),
               S("square", 400, ms=110, duty=0.25)],
}


def check(folder):
    """Compares every .wav with what its recipe renders now, byte for byte.
    The synthesis is deterministic, so any difference is a real one."""
    bad = 0

    for name in sorted(RECIPES):
        path = os.path.join(folder, name + ".wav")
        expected = render(RECIPES[name], vol=LEVEL).tobytes()
        if not os.path.exists(path):
            print("missing: %s.wav" % name)
            bad += 1
            continue
        with wave.open(path, "rb") as w:
            found = w.readframes(w.getnframes())
        if found != expected:
            print("differs from its recipe: %s.wav" % name)
            bad += 1

    extra = [f for f in os.listdir(folder)
             if f.endswith(".wav") and f[:-4] not in RECIPES]
    for f in sorted(extra):
        print("in the folder but without a recipe: %s" % f)
        bad += 1

    for name in sorted(RECIPES):
        if name not in USED_FOR:
            print("recipe without a description: %s" % name)
            bad += 1

    readme = os.path.join(folder, "README.md")
    if (not os.path.exists(readme)) or (open(readme).read() != listing()):
        print("sounds/README.md does not match the recipes")
        bad += 1

    if bad:
        sys.exit("%d to regenerate: ./sound_library.py" % bad)
    print("sounds: %d, all match their recipes" % len(RECIPES))


def main():
    here = os.path.dirname(os.path.abspath(__file__))
    folder = os.path.join(here, "..", "sounds")
    os.makedirs(folder, exist_ok=True)

    if "--check" in sys.argv:
        return check(folder)

    which = sys.argv[1:] or sorted(RECIPES)
    total = 0

    for name in which:
        if name not in RECIPES:
            sys.exit("unknown sound \"%s\". There are %d: %s"
                     % (name, len(RECIPES), ", ".join(sorted(RECIPES))))
        path = os.path.join(folder, name + ".wav")
        n = write_wav(path, render(RECIPES[name], vol=LEVEL))
        summary(path, n)
        total += n

    print("---\n%d sounds, %.0f ms in all, %.0f kB if loaded all together"
          % (len(which), total / RATE * 1000.0, total * 4 / 1024.0))

    if len(which) == len(RECIPES):
        with open(os.path.join(folder, "README.md"), "w") as f:
            f.write(listing())
        print("also wrote sounds/README.md")


def listing():
    """The README of the sounds folder, generated from the recipes."""
    lines = ["# ORION SDK sounds", "",
             "Generated by `tools/sound_library.py`. Do not edit them by hand:",
             "change the recipe and run `tools/sound_library.py` again.", "",
             "Copy the folder to `/sounds` on the microSD card. An app loads them as",
             "`shared/sounds/<name>.wav`:", "",
             "```lua",
             'local blip = orion.audio.sfx_load("shared/sounds/coin.wav")',
             "orion.audio.sfx_play(blip)",
             "```", "",
             "They are synthesized, so they are free of rights: use them, change",
             "them and distribute them with your app.", "",
             "| sound | ms | kB in memory | used for |",
             "|---|---:|---:|---|"]

    for name in sorted(RECIPES):
        n = len(render(RECIPES[name], vol=LEVEL))
        lines.append("| `%s` | %.0f | %.1f | %s |"
                     % (name, n / RATE * 1000.0, n * 4 / 1024.0,
                        USED_FOR.get(name, "")))

    lines += ["",
              "The memory size is twice the file size: mono sounds are doubled to",
              "stereo when loaded. An app can load 16 sounds at once, but they all",
              "use the app's own memory, so load only the ones you need.", ""]
    return "\n".join(lines)


if __name__ == "__main__":
    main()
