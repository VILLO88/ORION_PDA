-- tuner.lua: a guitar tuner. Play a string near the microphone.
-- category: music
--
-- Listens at 8000 Hz, takes 512 samples (64 ms) and finds the period with
-- autocorrelation: for each possible period, multiply the signal by itself
-- shifted, and keep the shift with the highest sum.

local RATE = 8000
local N = 512
local LAG_MIN, LAG_MAX = 24, 100   -- 333 Hz down to 80 Hz, the guitar range

local samples = {}
local note, cents, hz = "--", 0, 0
local on_string = false
local last_calc, last_draw = 0, 0
local cost_logged = false

local draw   -- defined below, used by init()
local W, H

local STRINGS = {
    {"E2", 82.41}, {"A2", 110.00}, {"D3", 146.83},
    {"G3", 196.00}, {"B3", 246.94}, {"E4", 329.63},
}

-- Beyond half a semitone from every string, show only the frequency.
local MAX_CENTS = 50

function init()
    local _, _, w, h = orion.sys.content_area()
    W, H = w, h
    orion.gfx.set_font(orion.gfx.system_font(0))

    local ok, err = orion.mic.listen("internal", RATE)
    if not ok then
        orion.sys.log("microphone: " .. tostring(err))
    else
        orion.sys.log("listening at " .. orion.mic.rate() .. " Hz")
    end

    draw()
end

local function frequency()
    local best, best_lag = 0, 0

    for lag = LAG_MIN, LAG_MAX do
        local sum = 0
        for i = 1, N - lag do
            sum = sum + samples[i] * samples[i + lag]
        end
        if sum > best then best, best_lag = sum, lag end
    end

    if best_lag == 0 then return 0 end

    -- Parabolic interpolation around the peak. Without it, near 330 Hz one
    -- lag step is almost 50 Hz.
    local a, b = 0, 0
    for i = 1, N - (best_lag - 1) do a = a + samples[i] * samples[i + best_lag - 1] end
    for i = 1, N - (best_lag + 1) do b = b + samples[i] * samples[i + best_lag + 1] end

    local shift = 0
    local den = a - 2 * best + b
    if den ~= 0 then shift = 0.5 * (a - b) / den end

    return RATE / (best_lag + shift)
end

local function nearest(f)
    if f <= 0 then return "--", 0, false end
    local best, dist = STRINGS[1], 1e9
    for _, s in ipairs(STRINGS) do
        local d = math.abs(1200 * math.log(f / s[2], 2))
        if d < dist then best, dist = s, d end
    end
    local c = 1200 * math.log(f / best[2], 2)
    if dist > MAX_CENTS then return "--", c, false end
    return best[1], c, true
end

function draw()
    orion.gfx.clear(orion.WHITE)
    orion.gfx.fill_rect(0, 0, W, 26, orion.BLACK)
    orion.gfx.text(8, 5, "TUNER", orion.WHITE, 2)

    -- input level, so you can see the microphone hears something
    local lv = orion.mic.level() or 0
    orion.gfx.rect(W - 40, 34, 24, 120, orion.BLACK)
    orion.gfx.fill_rect(W - 38, 152 - (lv * 116) // 1000, 20, (lv * 116) // 1000,
                        orion.BLACK)

    orion.gfx.text(40, 60, note, orion.BLACK, 8)
    orion.gfx.text(40, 140, string.format("%.1f Hz", hz), orion.BLACK, 2)

    local cx = W // 2
    orion.gfx.line(cx, 200, cx, 280, orion.BLACK)
    orion.gfx.rect(30, 200, W - 60, 80, orion.BLACK)

    if on_string then
        local x = cx + math.floor((cents / MAX_CENTS) * ((W - 80) / 2))
        if x < 34 then x = 34 end
        if x > W - 34 then x = W - 34 end
        orion.gfx.fill_rect(x - 3, 205, 6, 70, orion.BLACK)

        orion.gfx.text(36, 285, "flat", orion.BLACK, 1)
        orion.gfx.text(W - 70, 285, "sharp", orion.BLACK, 1)
        orion.gfx.text(cx - 40, 290, string.format("%+.0f cents", cents),
                       orion.BLACK, 2)
    else
        orion.gfx.text(cx - 95, 230, "no string nearby", orion.BLACK, 2)
    end

    orion.gfx.present()
end

function update()
    for ev in orion.input.events() do
        if ev.kind == "down" and ev.key == orion.K.ESC then
            orion.mic.listen_stop()
            orion.sys.exit()
            return
        end
    end

    -- Divided by 64 so the sum of 512 products fits in Lua's 32-bit integers.
    local new = orion.mic.read(N)
    for i = 1, #new do
        samples[#samples + 1] = new[i] // 64
    end
    while #samples > N do table.remove(samples, 1) end

    -- The autocorrelation is the expensive part: five times a second is enough.
    local now = orion.sys.ms()
    if (#samples >= N) and ((now - last_calc) >= 200) then
        last_calc = now

        local f = frequency()
        if not cost_logged then
            cost_logged = true
            orion.sys.log("autocorrelation: " .. (orion.sys.ms() - now) .. " ms")
        end

        if f > 60 and f < 400 then
            hz = f
            note, cents, on_string = nearest(f)
        end
    end

    if (now - last_draw) >= 150 then
        last_draw = now
        draw()
    end
end

function close()
    orion.mic.listen_stop()
end
