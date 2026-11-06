# ORION SDK
#
#   make          builds the emulator and lualint
#   make check    lints the examples and checks the tools
#   make clean    removes the binaries

.PHONY: all emulator lualint check clean

all: emulator lualint

emulator:
	@$(MAKE) -C emulator

lualint:
	@$(MAKE) -C tools lualint

check:
	@$(MAKE) -C tools check

clean:
	@$(MAKE) -C emulator clean
	@$(MAKE) -C tools clean

