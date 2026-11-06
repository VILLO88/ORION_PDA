-- metronome.lua: a pyramid metronome.
-- category: music
--
-- Keys: UP/DOWN change the tempo by 1, RIGHT/LEFT by 10, ENTER starts and
-- stops, ESC quits. The click needs the sound library in /sounds on the card;
-- without it the metronome still runs, silently.
--
-- The screen is split in three vertical panels: tempo on the left, the
-- pendulum in the middle, the beats on the right. Vertical, because the panel
-- updates vertical strips and their cost depends only on the width. The
-- pendulum moves 60 times a second inside the middle strip; the side panels
-- are sent only when they change.

local W, H, CX

local HELP = "UP/DOWN +-1   L/R +-10   ENTER   ESC"

local bpm     = 100
local running = false
local beat    = 1            -- 1..4, the first one is accented
local bars    = 0
local next_ms = 0            -- when the next beat falls
local side    = 1            -- which way the pendulum is swinging

local click_sound = nil

-- The strip goes from the pivot to the tip, so its width is the swing of the
-- tip: about 90 columns, ~12 ms of transfer in a 16 ms frame.
local ROD    = 170
local SWING  = 0.42          -- radians, about 24 degrees
local FOOT_H = 26

local PIVOT_Y, TOP_Y

-- Position of the sliding weight on the rod: d = A + B/bpm, a hyperbolic
-- scale like a real metronome, dense at the fast end.
local D_FAST, D_SLOW = 30, 165         -- at 300 and 30 bpm
local B = (D_SLOW - D_FAST) / (1 / 30 - 1 / 300)
local A = D_FAST - B / 300
local function weight_d(b) return A + B / b end

local SCALE = { 40, 60, 90, 150 }                   -- with a number
local TICKS = { 50, 70, 80, 100, 120, 200, 300 }     -- tick only

local NAMES = {
    { 40, "Grave" }, { 60, "Largo" }, { 66, "Larghetto" }, { 76, "Adagio" },
    { 108, "Andante" }, { 120, "Moderato" }, { 156, "Allegro" },
    { 176, "Vivace" }, { 200, "Presto" }, { 999, "Prestissimo" },
}
local function tempo_name(b)
    for _, n in ipairs(NAMES) do if b < n[1] then return n[2] end end
end

local shown_x    = nil       -- tip position in the last frame that was sent
local full       = true      -- redraw the whole screen
local beat_dirty = false     -- redraw the beats panel
local ang = 0

local function tip(a)
    local s, c = orion.math.sincos(a)
    return CX + ROD * s, PIVOT_Y - ROD * c, s, c
end

-- One beat is half a swing, from one end to the other. The click falls at
-- the end of the swing, where the rod is almost still.
local function angle(u)
    local _, c = orion.math.sincos(math.pi * u)
    return side * SWING * c
end

local G = orion.gfx
local BLACK, WHITE = orion.BLACK, orion.WHITE
local fl = math.floor

-- Half width of the case at height y: narrow at the top, wide at the bottom.
local CASE_TOP, CASE_BOTTOM = 34, 104
local function half(y)
    return fl(CASE_TOP + (CASE_BOTTOM - CASE_TOP) * (y - TOP_Y) / (PIVOT_Y + 14 - TOP_Y))
end

local function draw_case()
    local bottom = PIVOT_Y + 14

    -- the face, in 6-row steps that stay inside the slanted outline
    G.set_pattern("light")
    for y = TOP_Y, bottom - 1, 6 do
        local m = half(y)
        G.fill_rect(CX - m, y, 2 * m, 6, BLACK)
    end
    G.set_pattern(nil)

    G.line(CX - CASE_TOP, TOP_Y, CX - CASE_BOTTOM, bottom, BLACK)
    G.line(CX - CASE_TOP + 1, TOP_Y, CX - CASE_BOTTOM + 1, bottom, BLACK)
    G.line(CX + CASE_TOP, TOP_Y, CX + CASE_BOTTOM, bottom, BLACK)
    G.line(CX + CASE_TOP - 1, TOP_Y, CX + CASE_BOTTOM - 1, bottom, BLACK)
    G.line(CX - CASE_TOP + 7, TOP_Y + 6, CX - CASE_BOTTOM + 9, bottom - 4, BLACK)
    G.line(CX + CASE_TOP - 7, TOP_Y + 6, CX + CASE_BOTTOM - 9, bottom - 4, BLACK)

    G.fill_rect(CX - CASE_TOP - 6, TOP_Y - 8, 2 * CASE_TOP + 12, 8, BLACK)
    G.fill_rect(CX - 8, TOP_Y - 14, 16, 6, BLACK)

    G.set_pattern("dark")
    G.fill_rect(CX - CASE_BOTTOM - 12, bottom, 2 * CASE_BOTTOM + 24, 22, BLACK)
    G.set_pattern(nil)
    G.rect(CX - CASE_BOTTOM - 12, bottom, 2 * CASE_BOTTOM + 24, 22, BLACK)

    -- the scale plate behind the rod
    local s0 = fl(PIVOT_Y - weight_d(30)) - 12
    local s1 = fl(PIVOT_Y - weight_d(300)) + 12
    G.fill_rect(CX - 16, s0, 64, s1 - s0, WHITE)
    G.rect(CX - 16, s0, 64, s1 - s0, BLACK)
    for _, b in ipairs(TICKS) do
        G.fill_rect(CX - 10, fl(PIVOT_Y - weight_d(b)), 8, 1, BLACK)
    end
    for _, b in ipairs(SCALE) do
        local y = fl(PIVOT_Y - weight_d(b))
        G.fill_rect(CX - 12, y, 12, 2, BLACK)
        G.text(CX + 8, y - 6, tostring(b), BLACK, 2)
    end
end

local function draw_pendulum()
    local tx, ty, s, c = tip(ang)
    local d  = weight_d(bpm)
    local wx = fl(CX + d * s)
    local wy = fl(PIVOT_Y - d * c)

    tx, ty = fl(tx), fl(ty)
    G.line(CX - 1, PIVOT_Y, tx - 1, ty, BLACK)
    G.line(CX,     PIVOT_Y, tx,     ty, BLACK)
    G.line(CX + 1, PIVOT_Y, tx + 1, ty, BLACK)
    G.fill_rect(tx - 3, ty - 3, 7, 7, BLACK)

    G.fill_rect(wx - 13, wy - 9, 26, 18, BLACK)
    G.fill_rect(wx - 9, wy - 1, 18, 2, WHITE)

    G.fill_rect(CX - 7, PIVOT_Y - 7, 14, 14, BLACK)
    G.fill_rect(CX - 2, PIVOT_Y - 2, 4, 4, WHITE)
end

local function draw_footer()
    G.fill_rect(0, H - FOOT_H, W, FOOT_H, BLACK)
    G.text(16, H - FOOT_H + 6, HELP, WHITE, 2)
end

local LEFT_W = 150
local function draw_tempo()
    local s = tostring(bpm)
    local cx = LEFT_W // 2

    G.fill_rect(0, 0, LEFT_W, H - FOOT_H, WHITE)
    G.text(cx - G.text_width("TEMPO", 2) // 2, 24, "TEMPO", BLACK, 2)
    G.fill_rect(24, 44, LEFT_W - 48, 2, BLACK)
    G.text(cx - G.text_width(s, 5) // 2, 70, s, BLACK, 5)
    G.text(cx - G.text_width("BPM", 2) // 2, 122, "BPM", BLACK, 2)

    local n = tempo_name(bpm)
    local nw = G.text_width(n, 2)
    G.fill_rect(cx - nw // 2 - 8, 160, nw + 16, 26, BLACK)
    G.text(cx - nw // 2, 166, n, WHITE, 2)

    -- where this tempo sits between 30 and 300
    local x0, x1 = 16, LEFT_W - 16
    local x = x0 + (x1 - x0) * (bpm - 30) // 270
    G.fill_rect(x0, 230, x1 - x0, 2, BLACK)
    G.fill_rect(x0, 225, 2, 12, BLACK)
    G.fill_rect(x1 - 2, 225, 2, 12, BLACK)
    G.fill_rect(x - 3, 220, 7, 22, BLACK)
    G.text(x0, 246, "30", BLACK, 2)
    G.text(x1 - G.text_width("300", 2), 246, "300", BLACK, 2)
end

local RIGHT_W = 150
local function draw_beats()
    local x0 = W - RIGHT_W
    local cx = x0 + RIGHT_W // 2

    G.fill_rect(x0, 0, RIGHT_W, H - FOOT_H, WHITE)
    G.text(cx - G.text_width("4/4", 3) // 2, 22, "4/4", BLACK, 3)
    G.fill_rect(x0 + 24, 56, RIGHT_W - 48, 2, BLACK)

    -- 2x2 boxes: the current beat is filled, beat one has a double frame
    for i = 1, 4 do
        local x = cx - 46 + ((i - 1) % 2) * 52
        local y = 76 + ((i - 1) // 2) * 52
        local current = running and i == beat
        if current then
            G.fill_rect(x, y, 40, 40, BLACK)
        else
            G.rect(x, y, 40, 40, BLACK)
            if i == 1 then G.rect(x + 3, y + 3, 34, 34, BLACK) end
        end
        G.text(x + 14, y + 13, tostring(i), current and WHITE or BLACK, 2)
    end

    if running then
        local m = tostring(bars)
        G.text(cx - G.text_width("BAR", 2) // 2, 204, "BAR", BLACK, 2)
        G.text(cx - G.text_width(m, 3) // 2, 226, m, BLACK, 3)
    else
        G.text(cx - G.text_width("ENTER", 2) // 2, 204, "ENTER", BLACK, 2)
        G.text(cx - G.text_width("to start", 2) // 2, 228, "to start", BLACK, 2)
    end
end

local function draw_all()
    G.clear(WHITE)
    draw_tempo()
    draw_beats()
    draw_case()
    draw_pendulum()
    draw_footer()
end

function init()
    local _, _, w, h = orion.sys.content_area()
    W, H = w, h
    CX = W // 2
    PIVOT_Y = H - FOOT_H - 50
    TOP_Y   = PIVOT_Y - ROD - 20
    G.set_font(G.system_font(0))

    -- The click falls on the first frame after its time, so it can be up to
    -- one frame late: 16 ms at 60 fps, the maximum.
    orion.sys.set_fps(60)

    bpm = orion.pref.get("bpm", 100)
    if bpm < 30 or bpm > 300 then bpm = 100 end

    click_sound = orion.audio.sfx_load("shared/sounds/select.wav")

    ang = 0
    full = true
end

local function click()
    if not click_sound then return end
    orion.audio.sfx_play(click_sound, beat == 1 and 255 or 110)   -- accent on one
end

local function change(d)
    bpm = bpm + d
    if bpm < 30  then bpm = 30  end
    if bpm > 300 then bpm = 300 end
    orion.pref.set("bpm", bpm)
    -- The number on the left and the weight in the middle both move, so the
    -- whole screen is sent. Once per key press, that is fine.
    full = true
end

function update()
    for ev in orion.input.events() do
        if ev.kind == "down" then
            if     ev.key == orion.K.ESC   then orion.sys.exit(); return
            elseif ev.key == orion.K.UP    then change(1)
            elseif ev.key == orion.K.DOWN  then change(-1)
            elseif ev.key == orion.K.RIGHT then change(10)
            elseif ev.key == orion.K.LEFT  then change(-10)
            elseif ev.key == orion.K.ENTER then
                running = not running
                if running then
                    beat    = 4          -- so the first beat is one
                    bars    = 0
                    next_ms = orion.sys.ms()
                else
                    ang = 0
                end
                full = true
            end
        end
    end

    local interval = 60000 // bpm
    local now      = orion.sys.ms()

    if running then
        if now >= next_ms then
            beat = beat % 4 + 1
            if beat == 1 then bars = bars + 1 end
            side = -side
            click()
            -- add the interval to the previous beat, so a late frame does not
            -- shift every beat after it
            next_ms = next_ms + interval
            if now - next_ms > interval then next_ms = now + interval end
            beat_dirty = true
        end

        local u = 1.0 - (next_ms - now) / interval
        if u < 0 then u = 0 elseif u > 1 then u = 1 end
        ang = angle(u)
    end

    if full then
        draw_all()
        if G.present() then          -- false: the panel is busy, try again
            full, beat_dirty = false, false
            shown_x = fl(tip(ang))
        end
        return
    end

    -- One strip per frame. When the beat changes, the beats panel goes out
    -- instead of the pendulum; the rod is at the end of its swing and almost
    -- still, so the skipped frame does not show.
    if beat_dirty then
        draw_beats()
        if G.present_area(W - RIGHT_W, 0, RIGHT_W, H) then beat_dirty = false end
        return
    end

    local nx = fl(tip(ang))
    if shown_x == nx then return end      -- nothing moved, send nothing

    -- from the old tip to the new one, plus the pivot and the weight
    local x0 = math.min(shown_x, nx, CX) - 18
    local x1 = math.max(shown_x, nx, CX) + 18

    G.set_clip(x0, 0, x1 - x0, H)
    G.fill_rect(x0, 0, x1 - x0, H, WHITE)
    draw_case()
    draw_pendulum()
    draw_footer()
    G.clear_clip()

    -- update shown_x only if the strip was sent, or trails are left behind
    if G.present_area(x0, 0, x1 - x0, H) then shown_x = nx end
end
