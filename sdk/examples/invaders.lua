-- invaders.lua: five rows of invaders march and come down, four bunkers
-- crumble, a saucer crosses the top, and the march speeds up as they fall.
-- category: games
--
-- The code and the pictures are original, drawn on a 10x8 grid below.
--
-- Keys: arrows move, ENTER (or UP, or SPACE) fires, P pauses, ESC quits.

local gfx, K          = orion.gfx, orion.K
local fill, txt       = gfx.fill_rect, gfx.text
local down            = orion.input.is_down
local rnd, max, min   = math.random, math.max, math.min
local WHITE, BLACK    = orion.WHITE, orion.BLACK
local W, H

-- Things that move are far apart in x, so a single strip per frame would
-- almost always be the whole screen (13 frames a second). Instead the dirty
-- areas are kept separate (mark) and sent in turns (send), with the cannon
-- always first.
local OX                         -- left edge of the 304-pixel-wide panels

local S = 2                      -- each dot of a shape is 2x2 pixels

-- top to bottom
local HUD_Y    = 4
local SAUCER_Y = 24
local FORM_Y0  = 50
local BUNKER_Y, CANNON_Y, GROUND_Y, LIVES_Y

local IW, IH     = 20, 16        -- one invader's cell
local PX, PY     = 40, 22        -- distance between columns and rows
local COLS, ROWS = 11, 5
local STEP_X     = 4
local DROP       = 12

local CW, CH   = 26, 16          -- the cannon
local RW, RH   = 44, 32          -- a bunker: 22x16 cells of 2 px
local RC, RR   = 22, 16

-- A shape is a list of horizontal runs (dx, dy, width in pixels) packed in a
-- string, three bytes per run. Runs instead of dots: an invader is about 15
-- fill_rect calls instead of 50. Strings instead of tables keep memory low;
-- the first version of this game did not fit in Lua's heap.
local function shape(drawing)
    local t, r = {}, 0
    for row in drawing:gmatch("[.#]+") do
        local c, w = 1, #row
        while c <= w do
            if row:byte(c) == 35 then                       -- '#'
                local c0 = c
                while c <= w and row:byte(c) == 35 do c = c + 1 end
                t[#t + 1] = (c0 - 1) * S
                t[#t + 1] = r * S
                t[#t + 1] = (c - c0) * S
            else
                c = c + 1
            end
        end
        r = r + 1
    end
    return string.char(table.unpack(t))
end

local function draw_shape(f, x, y, color)
    color = color or WHITE
    for i = 1, #f, 3 do
        local dx, dy, w = f:byte(i, i + 2)
        fill(x + dx, y + dy, w, S, color)
    end
end

-- Three species, two poses each. The top row is worth the most.
local SPECIES = {
    { points = 30, a = shape [[
    ....##....
    ...####...
    ..######..
    .##.##.##.
    .########.
    ...#..#...
    ..#.##.#..
    .#.#..#.#.
]],
      b = shape [[
    ....##....
    ...####...
    ..######..
    .##.##.##.
    .########.
    ..#.##.#..
    .#......#.
    ..#....#..
]] },
    { points = 20, a = shape [[
    ..#....#..
    ...#..#...
    ..######..
    .##.##.##.
    ##########
    #.######.#
    #.#....#.#
    ...##.##..
]],
      b = shape [[
    ..#....#..
    #..#..#..#
    #.######.#
    ###.##.###
    ##########
    .########.
    ..#....#..
    .#......#.
]] },
    { points = 10, a = shape [[
    ...####...
    .########.
    ##########
    ##..##..##
    ##########
    ..##..##..
    .##.##.##.
    ##......##
]],
      b = shape [[
    ...####...
    .########.
    ##########
    ##..##..##
    ##########
    ..##..##..
    .#..##..#.
    ..#....#..
]] },
}
local ROW_SPECIES = { 1, 2, 2, 3, 3 }

local F_CANNON = shape [[
    ......#......
    .....###.....
    .....###.....
    .###########.
    #############
    #############
    #############
    #############
]]

local F_WRECK = {
    shape [[
    ....#...#....
    .#....#....#.
    ...#.....#...
    ..#..##.#....
    .....###..#..
    .#.######....
    ..########.#.
    #############
]],
    shape [[
    ..#.....#....
    ....#.#...#..
    .#.....#.....
    ...#.##...#..
    ..#..###.....
    ....#####.#..
    .#.#######...
    ###########.#
]],
}

local F_SAUCER = shape [[
    .....######.....
    ...##########...
    ..############..
    .##.##.##.##.##.
    ################
    ..###..##..###..
    ...#........#...
]]

local F_BLAST = shape [[
    #...#...#.
    .#..#..#..
    ..#...#...
    ##.....##.
    ..#...#...
    .#..#..#..
    #...#...#.
    ..........
]]

local F_BOLT = {
    shape [[
    .#.
    #..
    .#.
    ..#
    .#.
    #..
    .#.
]],
    shape [[
    .#.
    ..#
    .#.
    #..
    .#.
    ..#
    .#.
]],
}

-- Sounds from the SDK library (/sounds on the card). If the folder is
-- missing the game runs silently.
local SOUNDS = {
    shot   = "shoot",
    boom   = "explosion",
    step   = "step",
    hit    = "error",
    saucer = "alarm",
    bonus  = "extra_life",
    wave   = "victory",
    over   = "game_over",
}
local sounds = {}

local function play(name, vol)
    local s = sounds[name]
    if s then orion.audio.sfx_play(s, vol or 255) end
end

-- Dirty areas. Drawing goes to memory, which is always right; the screen is
-- what falls behind. Each touched piece is an area [a, b) in x: two close
-- ones merge, two distant ones stay separate.
local za, zb, zn = {}, {}, 0
local NEAR       = 24
local sweep      = 0             -- where the last round-robin send ended

-- Two sends per frame pair. The game advances every other update (60 fps
-- updates, 30 game ticks). On the tick it advances, the cannon's area goes
-- out (56 columns, 8 ms); on the next, a piece of the rest (144 columns,
-- 20 ms). With a single 224-column send the cannon waited its turn and moved
-- in jerks.
local W_CANNON, W_SWEEP = 56, 144

local DEBUG = false              -- true: log refused sends and memory every 300 frames
local d_frames, d_refused, d_zones = 0, 0, 0

local function mark(x, width)
    local a, b = x - 1, x + width + 1
    if a < 0 then a = 0 end
    if b > W then b = W end
    if b <= a then return end
    local i = 1
    while i <= zn do
        if a <= zb[i] + NEAR and b >= za[i] - NEAR then
            if za[i] < a then a = za[i] end
            if zb[i] > b then b = zb[i] end
            za[i], zb[i] = za[zn], zb[zn]
            zn = zn - 1
            i  = 1               -- it grew, it may touch another one
        else
            i = i + 1
        end
    end
    zn = zn + 1
    za[zn], zb[zn] = a, b
end

-- Sends one strip. With `from` it starts there; without, it continues to the
-- right of the last round-robin send and wraps around, so no area waits more
-- than one round, and an area wider than the limit goes out in pieces.
local function send(limit, from)
    if zn == 0 then return end
    local x0 = from
    if not x0 then
        for i = 1, zn do
            if zb[i] > sweep then
                local a = (za[i] > sweep) and za[i] or sweep
                if not x0 or a < x0 then x0 = a end
            end
        end
        if not x0 then
            sweep = 0
            x0 = za[1]
            for i = 2, zn do if za[i] < x0 then x0 = za[i] end end
        end
    end

    local x1, stop = x0 + limit, x0
    for i = 1, zn do
        if za[i] < x1 and zb[i] > x0 then
            local b = (zb[i] < x1) and zb[i] or x1
            if b > stop then stop = b end
        end
    end

    if stop <= x0 then return end

    -- false: the panel is still busy, the areas stay for next time
    local ok = gfx.present_area(x0, 0, stop - x0, H)
    if ok then
        if not from then sweep = stop end
        local n = zn
        for i = 1, n do
            local a, b = za[i], zb[i]
            if a < stop and b > x0 then          -- keep what is left on each side
                if a < x0 then zb[i] = x0 else za[i] = stop end
                if a < x0 and b > stop then
                    zn = zn + 1
                    za[zn], zb[zn] = stop, b
                end
            end
        end
        local i = 1
        while i <= zn do
            if zb[i] <= za[i] then
                za[i], zb[i] = za[zn], zb[zn]
                zn = zn - 1
            else
                i = i + 1
            end
        end
    end

    if DEBUG then
        d_frames = d_frames + 1
        if not ok then d_refused = d_refused + 1 end
        if zn > d_zones then d_zones = zn end
        if d_frames >= 300 then
            orion.sys.log(string.format("invaders: %d ticks/s, %d refused of 300, max %d areas queued, Lua %d KB",
                                        orion.sys.fps(), d_refused, d_zones, collectgarbage("count") // 1))
            d_frames, d_refused, d_zones = 0, 0, 0
        end
    end
end

local function erase(x, y, w, h)
    fill(x, y, w, h, BLACK)
    mark(x, w)
end

local screen  = "title"           -- title | game | over
local paused  = false
local tick    = false             -- the game advances every other update

local score, best, lives, wave = 0, 0, 3, 1
local bonus_given = false

local alive = {}                  -- alive[r][c]
local alive_count = 0
local form_x, form_y, form_dir, pose = 0, 0, 1, false
local step_wait = 0               -- frames to the next march step
local step_note = 0

local can_x, can_shown            -- the cannon, and where it was drawn
local dying = 0                   -- > 0: the cannon is exploding

local shot = nil                  -- { x, y } the player's shot
local bolts = {}                  -- the invaders' shots
local reload = 30

local saucer = nil                -- { x, dir }
local saucer_wait = 600
local saucer_prize = nil          -- { x, text, frame }

local blast = nil                 -- { x, y, frame }: the march waits
local bunkers = {}

-- A bunker row is one integer: bit c set means cell c is there. Four
-- bunkers are 64 numbers instead of 1400 booleans.
local function bunker_new(x)
    local s = { x = x, y = BUNKER_Y }
    for r = 0, RR - 1 do
        local bits = 0
        for c = 0, RC - 1 do
            local full = true
            if r < 4 and (c < 4 - r or c > RC - 5 + r) then full = false end   -- corners
            if r >= 12 then                                                   -- arch underneath
                local m = (r == 12) and 7 or ((r == 13) and 6 or 5)
                if c >= m and c < RC - m then full = false end
            end
            if full then bits = bits | (1 << c) end
        end
        s[r] = bits
    end
    return s
end

local function bunker_draw(s)
    for r = 0, RR - 1 do
        local row, c = s[r], 0
        while c < RC do
            if (row >> c) & 1 == 1 then
                local c0 = c
                while c < RC and (row >> c) & 1 == 1 do c = c + 1 end
                fill(s.x + c0 * 2, s.y + r * 2, (c - c0) * 2, 2, WHITE)
            else
                c = c + 1
            end
        end
    end
end

local function cell_off(s, r, c)
    if r < 0 or r >= RR or c < 0 or c >= RC then return end
    if (s[r] >> c) & 1 == 0 then return end
    s[r] = s[r] & ~(1 << c)
    fill(s.x + c * 2, s.y + r * 2, 2, 2, BLACK)
end

-- A shot bites three cells wide and four deep, with random edges, so no two
-- bites look the same.
local function bite(s, r, c, dir)
    for k = -1, 3 do
        local rr = r + k * dir
        cell_off(s, rr, c)
        if k < 3 or rnd(2) == 1 then
            cell_off(s, rr, c - 1)
            cell_off(s, rr, c + 1)
        end
        if (k == 0 or k == 1) and rnd(2) == 1 then
            cell_off(s, rr, c - 2)
            cell_off(s, rr, c + 2)
        end
    end
    mark(s.x + (c - 2) * 2, 10)
end

-- The bunker cells covered by a rectangle: first and last column and row.
local function cells_under(s, x, y, w, h)
    return max(0, (x - s.x) // 2), min(RC - 1, (x + w - 1 - s.x) // 2),
           max(0, (y - s.y) // 2), min(RR - 1, (y + h - 1 - s.y) // 2)
end

-- True if the rectangle touches a full bunker cell, which then gets bitten.
-- dir is -1 for a shot going up, +1 for one coming down.
local function hit_bunkers(x, y, w, h, dir)
    if y + h <= BUNKER_Y or y >= BUNKER_Y + RH then return false end
    for i = 1, #bunkers do
        local s = bunkers[i]
        if x + w > s.x and x < s.x + RW then
            local c0, c1, r0, r1 = cells_under(s, x, y, w, h)
            local from, to, step = r0, r1, 1
            if dir < 0 then from, to, step = r1, r0, -1 end
            for r = from, to, step do
                for c = c0, c1 do
                    if (s[r] >> c) & 1 == 1 then bite(s, r, c, dir); return true end
                end
            end
        end
    end
    return false
end

-- An invader coming down over a bunker eats it. Only the cells change here;
-- the invader's own drawing clears its cell on screen.
local function bunker_crush(x, y)
    if y + IH <= BUNKER_Y or y >= BUNKER_Y + RH then return end
    for i = 1, #bunkers do
        local s = bunkers[i]
        if x + IW > s.x and x < s.x + RW then
            local c0, c1, r0, r1 = cells_under(s, x, y, IW, IH)
            if c1 >= c0 then
                local mask = ~(((1 << (c1 - c0 + 1)) - 1) << c0)
                for r = r0, r1 do s[r] = s[r] & mask end
            end
        end
    end
end

local function inv_x(c) return form_x + (c - 1) * PX end
local function inv_y(r) return form_y + (r - 1) * PY end

local function inv_draw(r, c)
    local sp = SPECIES[ROW_SPECIES[r]]
    draw_shape(pose and sp.b or sp.a, inv_x(c), inv_y(r))
end

-- First and last column still occupied, and the lowest row.
local function bounds()
    local c0, c1, rb = nil, nil, 0
    for c = 1, COLS do
        for r = 1, ROWS do
            if alive[r][c] then
                c0 = c0 or c
                c1 = c
                if r > rb then rb = r end
            end
        end
    end
    return c0, c1, rb
end

-- Erasing a shot blacks out a rectangle; if an invader has moved into it,
-- part of the invader goes too. Redraw the invaders under it.
local function repair_invaders(x, y, w, h)
    if alive_count == 0 then return end
    local c0 = (x - form_x) // PX + 1
    local c1 = (x + w - 1 - form_x) // PX + 1
    local r0 = (y - form_y) // PY + 1
    local r1 = (y + h - 1 - form_y) // PY + 1
    for r = max(1, r0), min(ROWS, r1) do
        for c = max(1, c0), min(COLS, c1) do
            if alive[r][c] then inv_draw(r, c) end
        end
    end
end

-- Frames between march steps: fewer invaders, faster march.
local function pace()
    local f = (alive_count + 1) // 2 - min(wave - 1, 4) * 2
    if f < 1 then f = 1 end
    return f
end

local function march()
    local c0, c1, rb = bounds()
    if not c0 then return end

    local left  = inv_x(c0)
    local right = inv_x(c1) + IW
    local dx    = (alive_count == 1) and (STEP_X * 2) or STEP_X

    -- 1. erase everyone where they are
    for r = 1, ROWS do
        for c = 1, COLS do
            if alive[r][c] then fill(inv_x(c), inv_y(r), IW, IH, BLACK) end
        end
    end
    mark(left, right - left)

    -- 2. sideways, or down and turn around
    if (form_dir > 0 and right + dx > W - 4) or (form_dir < 0 and left - dx < 4) then
        form_y   = form_y + DROP
        form_dir = -form_dir
    else
        form_x = form_x + form_dir * dx
    end
    pose = not pose

    -- 3. draw everyone where they are now
    local low = (inv_y(rb) + IH > BUNKER_Y)
    for r = 1, ROWS do
        for c = 1, COLS do
            if alive[r][c] then
                if low then
                    bunker_crush(inv_x(c), inv_y(r))
                    fill(inv_x(c), inv_y(r), IW, IH, BLACK)
                end
                inv_draw(r, c)
            end
        end
    end
    mark(inv_x(c0), inv_x(c1) + IW - inv_x(c0))

    step_note = step_note % 4 + 1
    play("step", 255 - step_note * 30)
end

local function hud_score()
    fill(76, HUD_Y, 62, 14, BLACK)
    txt(76, HUD_Y, string.format("%05d", score), WHITE, 2)
end

local function hud_all()
    fill(0, 0, W, SAUCER_Y - 2, BLACK)
    txt(4, HUD_Y, "SCORE", WHITE, 2)
    hud_score()
    txt(W - 4 - 10 * 12, HUD_Y, string.format("BEST %05d", best), WHITE, 2)
end

local function lives_draw()
    fill(0, LIVES_Y, W, H - LIVES_Y, BLACK)
    txt(4, LIVES_Y + 2, tostring(lives), WHITE, 2)
    for i = 1, min(lives - 1, 4) do
        draw_shape(F_CANNON, 24 + (i - 1) * 32, LIVES_Y, WHITE)
    end
    txt(W - 4 - 7 * 12, LIVES_Y + 2, string.format("WAVE %2d", wave), WHITE, 2)
    mark(0, W)
end

local function cannon_draw()
    if dying > 0 then
        draw_shape(F_WRECK[(dying // 4) % 2 + 1], can_x, CANNON_Y)
    else
        draw_shape(F_CANNON, can_x, CANNON_Y)
    end
    can_shown = can_x
    mark(can_x, CW)
end

local function draw_all()
    gfx.clear(BLACK)
    hud_all()
    fill(0, GROUND_Y, W, 2, WHITE)
    lives_draw()
    for i = 1, #bunkers do bunker_draw(bunkers[i]) end
    for r = 1, ROWS do
        for c = 1, COLS do
            if alive[r][c] then inv_draw(r, c) end
        end
    end
    if saucer then draw_shape(F_SAUCER, saucer.x, SAUCER_Y) end
    cannon_draw()
    gfx.present()
    zn = 0
end

local function add_score(n)
    score = score + n
    hud_score()
    mark(76, 62)
    if not bonus_given and score >= 1500 then
        bonus_given = true
        lives = lives + 1
        lives_draw()
        play("bonus")
    end
end

local function new_wave()
    alive_count = 0
    for r = 1, ROWS do
        alive[r] = {}
        for c = 1, COLS do alive[r][c] = true; alive_count = alive_count + 1 end
    end
    form_x   = (W - ((COLS - 1) * PX + IW)) // 2
    -- each wave starts one step lower, up to four
    form_y   = FORM_Y0 + min(wave - 1, 4) * DROP
    form_dir = 1
    pose     = false
    step_wait = pace()

    bunkers = {}
    for i = 0, 3 do bunkers[i + 1] = bunker_new(72 + i * 116) end

    shot, bolts, blast   = nil, {}, nil
    saucer, saucer_prize = nil, nil
    saucer_wait = rnd(450, 750)
    reload    = 45
    dying     = 0
    can_x     = 8
end

local function new_game()
    score, lives, wave = 0, 3, 1
    bonus_given = false
    paused = false
    math.randomseed(orion.sys.ms())
    -- The first sound powers up the audio chain (~15 ms): do it here,
    -- silently, while a full frame goes out anyway.
    play("shot", 0)
    new_wave()
    screen = "game"
    draw_all()
end

local function game_over()
    screen = "over"
    if score > best then
        best = score
        orion.pref.set("best", best)     -- now: close() may never run
    end
    play("over")
    hud_all()
    fill(OX + 32, 120, 304 - 64, 96, BLACK)
    gfx.rect(OX + 32, 120, 304 - 64, 96, WHITE)
    txt(OX + 71, 134, "GAME OVER", WHITE, 3)
    txt(OX + 48, 172, string.format("SCORE %05d", score), WHITE, 2)
    txt(OX + 48, 194, "ENTER continue", WHITE, 2)
    gfx.present()
    zn = 0
end

local function draw_title()
    gfx.clear(BLACK)
    gfx.set_font(gfx.system_font(1))
    txt(OX + (304 - 8 * 32) // 2, 22, "INVADERS", WHITE, 4)
    gfx.set_font(gfx.system_font(0))

    local y = 82
    draw_shape(F_SAUCER, OX + 66, y + 1)
    txt(OX + 118, y, "= ? POINTS", WHITE, 2)
    for i = 1, 3 do
        y = y + 26
        draw_shape(SPECIES[i].a, OX + 72, y)
        txt(OX + 118, y, "= " .. SPECIES[i].points .. " POINTS", WHITE, 2)
    end

    txt(OX + (304 - 10 * 12) // 2, 198, string.format("BEST %05d", best), WHITE, 2)

    txt(OX + 20, 238, "ARROWS move    P pause", WHITE, 2)
    txt(OX + 20, 262, "ENTER  fire and start", WHITE, 2)
    txt(OX + 20, 286, "ESC    quit", WHITE, 2)
    gfx.present()
    zn = 0
end

local function fire()
    if shot or dying > 0 then return end
    shot = { x = can_x + CW // 2 - 1, y = CANNON_Y - 10 }
    play("shot", 200)
end

-- The player's shot against the formation: true if it hit someone.
local function shot_hits_invader()
    local c = (shot.x - form_x) // PX + 1
    if c < 1 or c > COLS then return false end
    local inside = shot.x - inv_x(c)
    if inside >= IW then return false end           -- in the gap between two columns
    for r = ROWS, 1, -1 do
        if alive[r][c] then
            local y = inv_y(r)
            -- the small one is narrower than its cell
            local narrow = (ROW_SPECIES[r] == 1) and (inside < 2 or inside >= IW - 2)
            if not narrow and shot.y < y + IH and shot.y + 10 > y then
                alive[r][c] = false
                alive_count = alive_count - 1
                erase(inv_x(c), y, IW, IH)
                draw_shape(F_BLAST, inv_x(c), y)
                blast = { x = inv_x(c), y = y, frame = 8 }
                add_score(SPECIES[ROW_SPECIES[r]].points)
                play("boom", 150)
                return true
            end
        end
    end
    return false
end

local function move_shot()
    if not shot then return end
    shot.y = shot.y - 9

    if shot.y < SAUCER_Y - 2 then shot = nil; return end

    if saucer and shot.y < SAUCER_Y + 14 and shot.x + 2 > saucer.x and shot.x < saucer.x + 32 then
        local prizes = { 50, 50, 100, 100, 150, 300 }
        local p = prizes[rnd(#prizes)]
        erase(saucer.x, SAUCER_Y, 32, 14)
        saucer_prize = { x = max(2, min(saucer.x, W - 40)), text = tostring(p), frame = 30 }
        txt(saucer_prize.x, SAUCER_Y, saucer_prize.text, WHITE, 2)
        mark(saucer_prize.x, 40)
        saucer = nil
        saucer_wait = rnd(450, 750)
        add_score(p)
        play("boom")
        shot = nil
        return
    end

    for i = #bolts, 1, -1 do
        local s = bolts[i]
        if shot.x + 2 > s.x and shot.x < s.x + 6 and shot.y < s.y + 14 and shot.y + 10 > s.y then
            table.remove(bolts, i)
            shot = nil
            return
        end
    end

    if shot_hits_invader() then shot = nil; return end
    if hit_bunkers(shot.x, shot.y, 2, 10, -1) then shot = nil end
end

local function cannon_hit()
    dying = 45
    lives = lives - 1
    bolts, shot = {}, nil
    lives_draw()
    play("hit")
end

local function move_bolts()
    local speed = 4 + ((wave >= 3) and 1 or 0)
    for i = #bolts, 1, -1 do
        local s = bolts[i]
        s.y = s.y + speed
        s.pose = not s.pose
        if s.y + 14 >= GROUND_Y then
            table.remove(bolts, i)
        elseif hit_bunkers(s.x, s.y, 6, 14, 1) then
            table.remove(bolts, i)
        elseif dying == 0 and s.y + 14 > CANNON_Y + 4 and s.x + 6 > can_x + 2 and s.x < can_x + CW - 2 then
            table.remove(bolts, i)
            cannon_hit()
            return
        end
    end
end

-- Usually a random column fires; one time in three, the column above the
-- cannon. That is what makes standing still dangerous.
local function new_bolt()
    local limit = (wave >= 2) and 3 or 2
    if #bolts >= limit or alive_count == 0 or dying > 0 then return end

    local c
    if rnd(3) == 1 then
        c = (can_x + CW // 2 - form_x) // PX + 1
    else
        c = rnd(COLS)
    end
    if c < 1 or c > COLS then return end

    for r = ROWS, 1, -1 do
        if alive[r][c] then
            local y = inv_y(r) + IH + 2
            if y + 14 < GROUND_Y then
                bolts[#bolts + 1] = { x = inv_x(c) + IW // 2 - 3, y = y, pose = false }
            end
            reload = rnd(14, 40) - min(wave, 5) * 2
            return
        end
    end
end

local function move_saucer()
    if saucer_prize then
        saucer_prize.frame = saucer_prize.frame - 1
        if saucer_prize.frame <= 0 then
            erase(saucer_prize.x, SAUCER_Y, 40, 14)
            saucer_prize = nil
        end
    end

    if saucer then
        saucer.x = saucer.x + saucer.dir * 3
        if saucer.x > W or saucer.x < -32 then
            saucer = nil
            saucer_wait = rnd(450, 750)
        end
        return
    end

    saucer_wait = saucer_wait - 1
    if saucer_wait <= 0 and alive_count >= 8 and not saucer_prize then
        local d = (rnd(2) == 1) and 1 or -1
        saucer = { x = (d > 0) and (-32) or W, dir = d }
        play("saucer", 120)
    end
end

local function step_game()
    -- (a) erase what moves, where it was drawn
    if shot then
        erase(shot.x, shot.y, 2, 10)
        repair_invaders(shot.x, shot.y, 2, 10)
    end
    for i = 1, #bolts do
        local s = bolts[i]
        erase(s.x, s.y, 6, 14)
        repair_invaders(s.x, s.y, 6, 14)
    end
    if saucer then erase(saucer.x, SAUCER_Y, 32, 14) end

    -- (b) advance the world by one tick
    if dying > 0 then
        erase(can_x, CANNON_Y, CW, CH)
        dying = dying - 1
        if dying == 0 then
            if lives <= 0 then game_over(); return end
            can_x = 8
        end
        cannon_draw()
    else
        local before = can_x
        if down(K.LEFT)  then can_x = can_x - 5 end
        if down(K.RIGHT) then can_x = can_x + 5 end
        if can_x < 4 then can_x = 4 end
        if can_x > W - 4 - CW then can_x = W - 4 - CW end
        if can_x ~= before then
            erase(can_shown, CANNON_Y, CW, CH)
            cannon_draw()
        end
    end

    move_shot()
    move_saucer()

    if blast then
        -- The march waits while a blast is on screen, otherwise erasing the
        -- blast would cut into the neighbour that moved over it.
        blast.frame = blast.frame - 1
        if blast.frame <= 0 then
            erase(blast.x, blast.y, IW, IH)
            blast = nil
            if alive_count == 0 then
                wave = wave + 1
                play("wave")
                new_wave()
                draw_all()
                return
            end
        end
    elseif dying == 0 then
        step_wait = step_wait - 1
        if step_wait <= 0 then
            march()
            step_wait = pace()
            local _, _, rb = bounds()
            if rb > 0 and inv_y(rb) + IH >= CANNON_Y then
                -- they reached the ground: game over, whatever lives are left
                lives = 0
                game_over()
                return
            end
        end

        reload = reload - 1
        if reload <= 0 then new_bolt() end
    end

    if dying == 0 then move_bolts() end

    -- (c) draw what moves, where it is now
    if shot then
        fill(shot.x, shot.y, 2, 10, WHITE)
        mark(shot.x, 2)
    end
    for i = 1, #bolts do
        local s = bolts[i]
        draw_shape(F_BOLT[s.pose and 2 or 1], s.x, s.y)
        mark(s.x, 6)
    end
    if saucer then
        draw_shape(F_SAUCER, saucer.x, SAUCER_Y)
        mark(saucer.x - 2, 36)
    end
end

function init()
    local _, _, w, h = orion.sys.content_area()
    W, H = w, h

    OX = (W - 304) // 2
    BUNKER_Y = H - 96
    CANNON_Y = H - 52
    GROUND_Y = H - 30
    LIVES_Y  = H - 22

    gfx.set_font(gfx.system_font(0))
    orion.sys.set_fps(60)

    -- By default Lua waits for memory to double before collecting. This game
    -- uses ~58 KB and allocates less than 1 KB a second, so start earlier and
    -- collect in small steps.
    collectgarbage("incremental", 120, 400, 10)

    for name, file in pairs(SOUNDS) do
        sounds[name] = orion.audio.sfx_load("shared/sounds/" .. file .. ".wav")
    end

    best = orion.pref.get("best", 0)
    draw_title()

    orion.sys.log("invaders: Lua memory " .. (collectgarbage("count") // 1) .. " KB")
end

function update()
    local fire_pressed = false

    for ev in orion.input.events() do
        if ev.kind == "down" then
            if ev.key == K.ESC then
                if screen == "title" then orion.sys.exit(); return end
                screen = "title"
                draw_title()
                return
            end
            if ev.key == K.ENTER or ev.key == K.UP or ev.ch == " " then
                fire_pressed = true
            end
            if (ev.ch == "p" or ev.ch == "P") and screen == "game" then
                paused = not paused
                if paused then
                    fill(OX + 80, 150, 304 - 160, 36, BLACK)
                    gfx.rect(OX + 80, 150, 304 - 160, 36, WHITE)
                    txt(OX + 116, 161, "PAUSED", WHITE, 2)
                    gfx.present()
                else
                    draw_all()
                end
            end
        end
    end

    if screen == "title" then
        if fire_pressed then new_game() end
        return
    end
    if screen == "over" then
        if fire_pressed then screen = "title"; draw_title() end
        return
    end
    if paused then return end

    if fire_pressed then fire() end

    tick = not tick
    if not tick then send(W_SWEEP); return end

    step_game()
    if screen ~= "game" then return end

    -- The cannon first: if its columns are dirty they go out now.
    for i = 1, zn do
        if za[i] < can_x + CW + 2 and zb[i] > can_x - 2 then
            send(W_CANNON, max(za[i], can_x - 12))
            return
        end
    end
    send(W_CANNON)
end
