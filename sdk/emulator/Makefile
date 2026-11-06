# The ORION emulator for the PC.
#
# RUNTIME lists the same files the firmware compiles for the device; only the
# layer underneath (pixels, keys, files, sound) is different, in emu_*.c.

RT  := ../runtime
LUA := $(RT)/lua/src

RUNTIME := \
  $(RT)/src/orion_api.c      \
  $(RT)/src/orion_ui.c       \
  $(RT)/src/orion_mem.c      \
  $(RT)/src/orion_lua.c      \
  $(RT)/src/orion_lua_bind.c \
  $(RT)/src/orion_pref.c     \
  $(RT)/src/app_lua.c        \
  $(RT)/src/app_host.c       \
  $(RT)/src/bitmap_fonts.c

EMU := emu_main.c emu_lcd.c emu_hw.c emu_fs.c emu_audio.c emu_math.c emu_serial.c \
       emu_j4.c emu_ble.c

CFLAGS := -std=gnu11 -O1 -g -Wall \
          -Ishim -I$(RT)/inc -I$(LUA) \
          $(shell sdl2-config --cflags) \
          -DORION_EMULATORE=1
LDFLAGS := $(shell sdl2-config --libs) -lm

# Windows (MSYS2 UCRT64): sdl2-config adds -mwindows, which hides the
# console, and the console is where orion.sys.log and Lua errors go.
ifeq ($(OS),Windows_NT)
LDFLAGS := $(filter-out -mwindows,$(LDFLAGS)) -mconsole
endif

orion-emu: $(EMU) $(RUNTIME) $(wildcard $(LUA)/*.c)
	$(CC) $(CFLAGS) -o $@ $(EMU) $(RUNTIME) $(LUA)/*.c $(LDFLAGS)

clean:
	rm -f orion-emu
	rm -rf orion-emu.dSYM

check:
	@$(MAKE) -C .. check

.PHONY: clean check
