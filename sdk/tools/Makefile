# Tools for app authors: lualint and the checks of the SDK itself.
# lualint is built from the same Lua sources the device runs.
LUA := ../runtime/lua/src

lualint: lualint.c $(wildcard $(LUA)/*.c)
	$(CC) -O1 -std=c99 -DLUA_USE_POSIX -I$(LUA) -o $@ lualint.c $(LUA)/*.c -lm

# make check: lint the examples, check the image tools and the sound library
check: lualint images sounds panel
	@ok=0; for f in ../examples/*.lua; do ./lualint "$$f" || ok=1; done; exit $$ok

images:
	@./check_images.sh

panel:
	@$(MAKE) -s -C ../emulator
	@./check_panel.sh

sounds:
	@python3 sound_library.py --check

clean:
	rm -f lualint

.PHONY: check images panel sounds clean

