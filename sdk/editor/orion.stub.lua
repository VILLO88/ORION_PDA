---@meta
--- ORION API definitions for the editor. This file is not run and does not go
--- on the card: lua-language-server (the "Lua" extension for VS Code) uses it
--- to complete names, show arguments and flag misspelled functions while you
--- type.

---@class orion
orion = {}

--- White (0).
orion.WHITE = 0
--- Black (1).
orion.BLACK = 1
--- Screen width in pixels (536).
orion.W = 536
--- Screen height in pixels (336).
orion.H = 336
--- Key codes: `orion.K.ESC`, `.ENTER`, `.DEL`, `.BACK`, `.UP`, `.DOWN`,
--- `.LEFT`, `.RIGHT`, `.MENU`, `.SAVE`, `.SEARCH`, `.PLAY`, `.NEXT`, `.PREV`,
--- `.VOL_UP`, `.VOL_DOWN`, `.MUTE`, `.SHIFT`, `.FN`.
orion.K = {}

-- ========================================================================
--  gfx: drawing
-- ========================================================================
---@class orion.gfx
orion.gfx = {}

--- Fills the whole screen. Default colour: white.
---@param color? integer
function orion.gfx.clear(color) end
--- Coordinates may have a fraction; they are rounded down.
---@param x number @param y number @param color? integer
function orion.gfx.pixel(x, y, color) end
function orion.gfx.line(x0, y0, x1, y1, color) end
--- The outline of a rectangle.
function orion.gfx.rect(x, y, w, h, color) end
--- A filled rectangle, using the pattern set with `set_pattern`.
function orion.gfx.fill_rect(x, y, w, h, color) end
--- Fill pattern: `"black"`, `"dark"`, `"gray"`, `"light"`, `"white"`,
--- `"hlines"`, `"vlines"`, `"grid"`; or a table of 8 numbers (an 8x8 tile,
--- high bit on the left, 1 = white); or `nil` for solid fills.
---@param pattern string|integer[]|nil
function orion.gfx.set_pattern(pattern) end
--- Draws text with its top left corner at (x, y). `scale` defaults to 1.
---@param x number @param y number @param text string
---@param color? integer @param scale? integer
function orion.gfx.text(x, y, text, color, scale) end
--- Width in pixels of `text` drawn with the current font at `scale`.
--- Counts characters, not bytes. Draws nothing.
---@return integer
function orion.gfx.text_width(text, scale) end
--- A system font: 0 = 5x7, 1 = 8x8, 2 = 6x12.
---@param n integer
function orion.gfx.system_font(n) end
function orion.gfx.set_font(font) end
--- Font measurements at scale 1 (the current font if no argument).
---@return {cell_w: integer, cell_h: integer, advance_w: integer, advance_h: integer}
function orion.gfx.font_metrics(font) end
--- Loads an `.obm` image. Returns `nil` and a reason on failure.
---@param path string
---@return orion.image|nil, string|nil
function orion.gfx.image(path) end
--- Sends the whole screen to the display: ~75 ms. Returns false if the
--- previous transfer is still running.
---@return boolean
function orion.gfx.present() end
--- Sends one vertical strip. `y` and `h` are ignored: the strip is always
--- the full height. About 230 columns fit in a frame at 30 fps. Returns
--- false if the strip was not sent: check it.
---@return boolean
function orion.gfx.present_area(x, y, w, h) end
--- Limits drawing to a rectangle.
function orion.gfx.set_clip(x, y, w, h) end
function orion.gfx.clear_clip() end

---@class orion.image
local image = {}
--- Width and height.
---@return integer, integer
function image:size() end
--- Draws the image with its top left corner at (x, y).
function image:draw(x, y) end
--- Frees the memory now (it is freed anyway when the app closes).
function image:free() end

-- ========================================================================
--  input: keys
-- ========================================================================
---@class orion.input
orion.input = {}
--- The next event, or `nil`.
function orion.input.read() end
--- For a `for` loop: `for ev in orion.input.events() do`. Each event has
--- `kind` ("down"/"up"), `key` (an `orion.K` code, 0 for character keys),
--- `ch` (the character, or nil), `shift`, `fn` and `ms`.
function orion.input.events() end
--- Whether a key is held right now. Takes an `orion.K` code or a character
--- code: `is_down(string.byte("a"))`.
---@param key integer
---@return boolean
function orion.input.is_down(key) end

-- ========================================================================
--  sys
-- ========================================================================
---@class orion.sys
orion.sys = {}
--- Milliseconds since power-on.
---@return integer
function orion.sys.ms() end
--- How many times a second update() is called (max 60).
---@param n integer
function orion.sys.set_fps(n) end
--- How many times a second update() actually runs.
---@return integer
function orion.sys.fps() end
--- Battery charge, percent.
---@return integer
function orion.sys.battery() end
---@return boolean
function orion.sys.is_charging() end
--- Year, month, day, hour, minute, second.
function orion.sys.date_time() end
--- The usable area: x, y, width, height.
---@return integer, integer, integer, integer
function orion.sys.content_area() end
---@return string
function orion.sys.version() end
--- Closes the app and returns to the launcher.
function orion.sys.exit() end
--- Writes a line to the USB console (the terminal in the emulator).
function orion.sys.log(text) end

-- ========================================================================
--  ui: system dialogs
-- ========================================================================
---@class orion.ui
orion.ui = {}
--- Asks yes/no. The app gets no update() while the dialog is open, and must
--- redraw its screen afterwards.
---@return boolean
function orion.ui.confirm(question) end
--- Asks for a line of text (at most 63 bytes). `nil` if cancelled.
---@return string|nil
function orion.ui.ask_text(question, initial) end
--- Lets the user pick from a list (at most 16 items). Returns the index
--- from 1, or `nil`.
---@param items string[]
---@return integer|nil
function orion.ui.choose(title, items) end
--- A message that closes by itself after about two seconds.
function orion.ui.notice(text) end

-- ========================================================================
--  fs: files
-- ========================================================================
---@class orion.fs
orion.fs = {}
--- `"data/..."` is the app's folder, `"shared/..."` the whole card.
--- Modes: `"read"` (default), `"write"`, `"append"`, or `"r"`, `"w"`, `"a"`.
--- At most 4 files open at once.
---@return orion.file|nil, string|nil
function orion.fs.open(path, mode) end
--- A whole file as a string, up to 64 KB. `nil` and a reason on failure.
---@return string|nil, string|nil
function orion.fs.read_all(path) end
--- Writes a whole file at once. The card works in 512-byte sectors: many
--- small writes cost far more than one large one.
---@return boolean|nil, string|nil
function orion.fs.write_all(path, content) end
---@return boolean
function orion.fs.exists(path) end
---@return integer|nil
function orion.fs.size(path) end
---@return boolean
function orion.fs.remove(path) end
--- Replaces the destination if it exists.
---@return boolean
function orion.fs.rename(from, to) end
---@return boolean
function orion.fs.make_dir(path) end
--- Iterator over a folder: entries have `name`, `is_dir`, `size`, `modified`.
function orion.fs.list(path) end
--- Free bytes on the card. Check before saving something large.
---@return integer
function orion.fs.free_space() end

---@class orion.file
local file = {}
--- Up to `n` bytes; without `n`, the rest of the file (up to 64 KB). `nil`
--- at the end.
---@return string|nil
function file:read(n) end
---@return integer|nil, string|nil
function file:write(data) end
function file:close() end

-- ========================================================================
--  pref: saved settings
-- ========================================================================
---@class orion.pref
orion.pref = {}
--- The value saved under `key`, or `default`. The type of `default` decides
--- the type of the result (number or string).
function orion.pref.get(key, default) end
--- Saves an integer or a string (up to 127 characters) under `key`, at once.
function orion.pref.set(key, value) end

-- ========================================================================
--  audio
-- ========================================================================
---@class orion.audio
orion.audio = {}
--- Plays a WAV or MP3 file (up to 48 kHz). Uses the whole audio chain.
---@return boolean|nil, string|nil
function orion.audio.play_file(path) end
function orion.audio.stop() end
---@return boolean
function orion.audio.is_playing() end
--- Output volume, -95 to 0 dB. One volume for music and effects; it belongs
--- to the user.
---@return boolean
function orion.audio.set_volume(db) end
---@return integer
function orion.audio.position_ms() end
---@return integer
function orion.audio.duration_ms() end
--- True if the output is a Bluetooth speaker instead of the jack.
---@return boolean
function orion.audio.is_bluetooth() end
--- Loads a short sound (WAV 48 kHz 16 bit, at most 5 s). Returns `nil` and a
--- reason on failure. The sound library is in `shared/sounds/`.
---@return integer|nil, string|nil
function orion.audio.sfx_load(path) end
--- Plays it on top of the music, `vol` 0..255. Up to four at once.
---@return boolean
function orion.audio.sfx_play(id, vol) end
function orion.audio.sfx_free(id) end
function orion.audio.sfx_stop() end

-- ========================================================================
--  math: what the chip does in hardware
-- ========================================================================
---@class orion.math
orion.math = {}
--- Sine and cosine together, angle in radians of any value.
---@param rad number
---@return number, number
function orion.math.sincos(rad) end
--- The angle of a vector, in radians.
---@return number
function orion.math.atan2(dy, dx) end
--- sqrt(dx*dx + dy*dy).
---@return number
function orion.math.dist(dx, dy) end

-- ========================================================================
--  serial: the J4 serial port
-- ========================================================================
---@class orion.serial
orion.serial = {}
--- Powers `+3V3_EXT` and starts the UART. Default 115200 baud.
---@param baud? integer
---@return boolean|nil ok, string? reason
function orion.serial.open(baud) end
--- Releases the pins and the supply. The firmware calls it when the app exits.
function orion.serial.close() end
---@return boolean
function orion.serial.is_open() end
--- Waits until the bytes are sent. Returns how many were written.
---@param data string
---@return integer
function orion.serial.write(data) end
--- What has arrived, at most `max` bytes (512). "" if nothing, never nil.
---@param max? integer
---@return string
function orion.serial.read(max) end
--- Bytes waiting in the firmware's buffer.
---@return integer
function orion.serial.available() end
--- Bytes dropped because the 4 KB buffer was full.
---@return integer
function orion.serial.lost() end

-- ========================================================================
--  gpio: the four J4 lines (EXT_GPIO1..4)
-- ========================================================================
---@class orion.gpio
orion.gpio = {}
--- `mode`: "off", "in", "in_pullup", "in_pulldown", "out", "out_od".
--- Outputs start low. The first pin in use powers `+3V3_EXT`.
---@param pin integer 1..4
---@param mode string
---@return boolean|nil ok, string? reason
function orion.gpio.mode(pin, mode) end
---@param pin integer
---@param level boolean|integer
---@return boolean|nil ok, string? reason
function orion.gpio.write(pin, level) end
--- 0 or 1; nil if the pin is "off".
---@param pin integer
---@return integer|nil level, string? reason
function orion.gpio.read(pin) end
--- All pins off. The firmware calls it when the app exits.
function orion.gpio.close() end

-- ========================================================================
--  i2c: I2C4 on J4, master, 7-bit addresses
-- ========================================================================
---@class orion.i2c
orion.i2c = {}
--- 10, 100 (default) or 400 kHz. Powers `+3V3_EXT`.
---@param khz? integer
---@return boolean|nil ok, string? reason
function orion.i2c.open(khz) end
function orion.i2c.close() end
---@return boolean
function orion.i2c.is_open() end
--- At most 255 bytes.
---@param addr integer
---@param data string
---@return boolean|nil ok, string? reason
function orion.i2c.write(addr, data) end
---@param addr integer
---@param n integer 1..255
---@return string|nil data, string? reason
function orion.i2c.read(addr, n) end
--- Write, repeated start, read: a register read.
---@param addr integer
---@param data string
---@param n integer 1..255
---@return string|nil data, string? reason
function orion.i2c.write_read(addr, data, n) end
---@param addr integer
---@return boolean
function orion.i2c.probe(addr) end
--- The addresses that answer.
---@return integer[]
function orion.i2c.scan() end

-- ========================================================================
--  ble: text messages over Bluetooth (a phone or PC connects to ORION)
-- ========================================================================
---@class orion.ble
orion.ble = {}
--- Powers the module if needed and takes the data channel.
---@return boolean|nil ok, string? reason
function orion.ble.open() end
function orion.ble.close() end
---@return boolean
function orion.ble.is_open() end
--- A phone or PC is connected.
---@return boolean
function orion.ble.is_connected() end
--- A text message, 1..492 bytes, no CR/LF/NUL. Keep it under 180 bytes
--- unless you have measured the link's MTU.
---@param text string
---@return boolean|nil ok, string? reason
function orion.ble.send(text) end
--- The oldest message, or nil.
---@return string|nil
function orion.ble.receive() end
--- Messages dropped because the 4 KB queue was full.
---@return integer
function orion.ble.lost() end
--- The name the phone sees.
---@return string
function orion.ble.name() end

-- ========================================================================
--  mem: large memory blocks
-- ========================================================================
---@class orion.mem
orion.mem = {}
--- A memory block. `kind` = `"fast"` (internal SRAM, small) or `nil` (usually
--- PSRAM: 30 MB/s in blocks, but 488 ns for a scattered read). Returns `nil`
--- and a reason if there is not enough memory.
---@return orion.block|nil, string|nil
function orion.mem.alloc(bytes, kind) end
---@return integer
function orion.mem.free_fast() end
---@return integer
function orion.mem.free_large() end

---@class orion.block
local block = {}
---@return integer
function block:size() end
---@return boolean
function block:is_fast() end
function block:free() end
--- At most 4096 bytes per call.
---@return string|nil
function block:read(offset, n) end
---@return integer|nil
function block:write(offset, data) end
--- Fills the block from a file. Optional offset and count.
---@return integer|nil
function block:load(path, offset, n) end
--- Writes the block to a file. Optional offset and count.
---@return integer|nil
function block:save(path, offset, n) end

-- ========================================================================
--  mic: listening
-- ========================================================================
---@class orion.mic
orion.mic = {}
--- Records to a WAV file. `source` = `"internal"` (default) or `"headset"`.
---@return boolean|nil, string|nil
function orion.mic.rec_file(path, source) end
function orion.mic.rec_stop() end
---@return boolean
function orion.mic.is_recording() end
---@return integer
function orion.mic.rec_seconds() end
--- Sensitivity 0 to 4.
---@return boolean
function orion.mic.set_gain(n) end
--- Input level 0..1000, `nil` if not listening.
---@return integer|nil
function orion.mic.level() end
--- Listens without writing a file. `hz` must divide 48000 (default 8000).
---@return boolean|nil, string|nil
function orion.mic.listen(source, hz) end
function orion.mic.listen_stop() end
--- A table of up to `n` samples (default 256, max 512), signed 16-bit.
---@return integer[]
function orion.mic.read(n) end
--- The sample rate actually in use.
---@return integer
function orion.mic.rate() end

-- ========================================================================
--  The three functions an app defines
-- ========================================================================
--- Once, at the start.
function init() end
--- Every frame. Aim for ~25 ms; never more than ~150 ms.
function update() end
--- Before the app is unloaded. May never be called (battery removed,
--- fault): save data when it changes.
function close() end
