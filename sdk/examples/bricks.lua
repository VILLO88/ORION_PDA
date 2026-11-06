-- bricks.lua: a brick breaker with a title screen, high scores and three
-- difficulty levels.
-- category: games
--
-- Keys: arrows move, ENTER launches the ball, ESC goes back to the title.
--
-- How it draws: each frame it works out one vertical strip that covers
-- everything that moved (ball, paddle, a broken brick), redraws that strip
-- from scratch and sends only that with present_area.

local W, H

-- The strip changed in this frame, as x0..x1.
local dirty_x0, dirty_x1

-- One column costs about 0.141 ms to send, so a 33 ms frame holds ~230 of
-- them. Keep the strip under that or the next present_area is refused.
local MAX_COLUMNS = 200

-- The score sits in the top left corner, far from the ball. It is redrawn
-- in a later frame when the strip has room for it.
local score_dirty = false

-- Sounds from the SDK library (/sounds on the card). Left: the name the
-- game uses. Right: the file.
local SOUNDS = {
    brick  = "brick",
    paddle = "bounce",
    wall   = "step",
    life   = "error",
    over   = "game_over",
    clear  = "victory",
}

local sounds = {}

-- If a file is missing, sfx_load returns nil and play() does nothing.
local function play(name, vol)
    local s = sounds[name]
    if s then orion.audio.sfx_play(s, vol or 255) end
end

local function mark(x, width)
    local a, b = math.floor(x) - 1, math.floor(x) + width + 1
    if not dirty_x0 then dirty_x0, dirty_x1 = a, b; return end
    if a < dirty_x0 then dirty_x0 = a end
    if b > dirty_x1 then dirty_x1 = b end
end

-- Harder levels are faster and also have a narrower paddle.
local LEVELS = {
    { name = "EASY",   speed = 2.6, paddle = 88 },
    { name = "NORMAL", speed = 3.8, paddle = 68 },
    { name = "HARD",   speed = 5.2, paddle = 48 },
}
local level = 2

local function key(i) return "best" .. i .. "_" .. level end

local function read_best()
    local r = {}
    for i = 1, 3 do r[i] = orion.pref.get(key(i), 0) end
    return r
end

local function save_best(p)
    local r = read_best()
    r[#r + 1] = p
    table.sort(r, function(a, b) return a > b end)
    for i = 1, 3 do orion.pref.set(key(i), r[i] or 0) end
end

local screen = "title"

local ROWS, COLS = 5, 13
local B_W, B_H, B_GAP = 36, 14, 4
local WALL_Y = 40

local wall, bricks_left = {}, 0

local PAD_W, PAD_H = 68, 10
local pad_x, pad_y
local pad_vx = 0     -- how far the paddle moved this frame, passed on to the ball

local ball_x, ball_y, ball_vx, ball_vy
local BALL = 8
local stuck = true

local score, lives = 0, 3
local over = false

-- Where ball and paddle were in the last frame that reached the screen.
local shown_ball_x, shown_pad_x = 0, 0

local function reset_ball()
    stuck = true
    ball_x = pad_x + (PAD_W - BALL) / 2
    ball_y = pad_y - BALL - 1
    ball_vx, ball_vy = LEVELS[level].speed, -LEVELS[level].speed
end

local function build_wall()
    wall, bricks_left = {}, 0
    local margin = (W - (COLS * (B_W + B_GAP) - B_GAP)) // 2
    for r = 1, ROWS do
        wall[r] = {}
        for c = 1, COLS do
            wall[r][c] = { x = margin + (c - 1) * (B_W + B_GAP),
                           y = WALL_Y + (r - 1) * (B_H + B_GAP), alive = true }
            bricks_left = bricks_left + 1
        end
    end
end

-- One pattern per row, so the rows can be told apart on a 1-bit screen.
local PATTERNS = { "black", "dark", "gray", "light", "hlines" }

-- The title screen draws itself when there is no cover image. To use your
-- own picture:
--   tools/image.py my_cover.png .../apps/data/bricks/cover.obm --width 536 --height 336
local cover = nil
local cover_tried = false

local function draw_title()
    if not cover_tried then
        cover_tried = true
        cover = orion.gfx.image("data/cover.obm")   -- nil if missing
    end

    orion.gfx.clear(orion.WHITE)

    if cover then
        cover:draw(0, 0)
    else
        orion.gfx.fill_rect(0, 30, W, 62, orion.BLACK)
        local t = "BRICKS"
        orion.gfx.text((W - orion.gfx.text_width(t, 6)) // 2, 44, t, orion.WHITE, 6)

        -- a small wall that also shows the five patterns
        for c = 0, 12 do
            orion.gfx.set_pattern(PATTERNS[(c % 5) + 1])
            orion.gfx.fill_rect(24 + c * 40, 104, 32, 12, orion.BLACK)
            orion.gfx.set_pattern(nil)
            orion.gfx.rect(24 + c * 40, 104, 32, 12, orion.BLACK)
        end
    end

    -- On top of a picture, black text needs a white box behind it.
    if cover then
        orion.gfx.fill_rect(24, 132, 240, 118, orion.WHITE)
        orion.gfx.rect(24, 132, 240, 118, orion.BLACK)
        orion.gfx.fill_rect(W - 266, 132, 242, 118, orion.WHITE)
        orion.gfx.rect(W - 266, 132, 242, 118, orion.BLACK)
    end

    orion.gfx.text(40, 140, "DIFFICULTY", orion.BLACK, 2)
    for i, L in ipairs(LEVELS) do
        local y = 168 + (i - 1) * 26
        if i == level then
            orion.gfx.fill_rect(36, y - 4, 200, 24, orion.BLACK)
            orion.gfx.text(48, y, L.name, orion.WHITE, 2)
        else
            orion.gfx.text(48, y, L.name, orion.BLACK, 2)
        end
    end

    orion.gfx.text(W - 250, 140, "BEST", orion.BLACK, 2)
    local r = read_best()
    for i = 1, 3 do
        orion.gfx.text(W - 250, 168 + (i - 1) * 26,
                       i .. ".   " .. r[i], orion.BLACK, 2)
    end

    orion.gfx.fill_rect(0, H - 34, W, 34, orion.BLACK)
    orion.gfx.text(20, H - 26, "UP/DOWN level   ENTER play   ESC quit",
                   orion.WHITE, 2)
    orion.gfx.present()
end

local function draw_brick(b, row)
    orion.gfx.set_pattern(PATTERNS[row])
    orion.gfx.fill_rect(b.x, b.y, B_W, B_H, orion.BLACK)
    orion.gfx.set_pattern(nil)      -- the border must be solid
    orion.gfx.rect(b.x, b.y, B_W, B_H, orion.BLACK)
    orion.gfx.rect(b.x + 2, b.y + 2, B_W - 4, B_H - 4, orion.WHITE)
end

local function draw_bar()
    orion.gfx.fill_rect(0, 0, W, 26, orion.BLACK)
    orion.gfx.text(8, 6, "SCORE " .. score, orion.WHITE, 2)
    orion.gfx.text(W // 2 - 90, 6, LEVELS[level].name, orion.WHITE, 2)
    -- the real frame rate: below 30 means the game is not keeping up
    orion.gfx.text(W // 2 + 60, 6, orion.sys.fps() .. "/s", orion.WHITE, 2)
    orion.gfx.text(W - 130, 6, "LIVES " .. lives, orion.WHITE, 2)
end

local function draw_strip(x0, x1)
    local width = x1 - x0
    if width <= 0 then return end

    orion.gfx.set_clip(x0, 0, width, H)
    orion.gfx.fill_rect(x0, 0, width, H, orion.WHITE)

    -- everything that falls in the strip, drawn again and clipped
    draw_bar()
    orion.gfx.fill_rect(0, 26, W, 2, orion.BLACK)

    for r = 1, ROWS do
        for c = 1, COLS do
            local b = wall[r][c]
            if b.alive and (b.x + B_W >= x0) and (b.x <= x1) then
                draw_brick(b, r)
            end
        end
    end

    orion.gfx.fill_rect(pad_x, pad_y, PAD_W, PAD_H, orion.BLACK)
    orion.gfx.fill_rect(ball_x, ball_y, BALL, BALL, orion.BLACK)
    orion.gfx.clear_clip()
end

local function draw_all()
    orion.gfx.clear(orion.WHITE)
    draw_bar()
    orion.gfx.fill_rect(0, 26, W, 2, orion.BLACK)
    for r = 1, ROWS do
        for c = 1, COLS do
            if wall[r][c].alive then draw_brick(wall[r][c], r) end
        end
    end
    orion.gfx.fill_rect(pad_x, pad_y, PAD_W, PAD_H, orion.BLACK)
    orion.gfx.fill_rect(ball_x, ball_y, BALL, BALL, orion.BLACK)
    if over then
        orion.gfx.fill_rect(W // 2 - 180, H // 2 - 40, 360, 80, orion.BLACK)
        orion.gfx.text(W // 2 - 150, H // 2 - 26, "GAME OVER - " .. score,
                       orion.WHITE, 3)
        orion.gfx.text(W // 2 - 150, H // 2 + 8, "ENTER for the title screen",
                       orion.WHITE, 1)
    end
    orion.gfx.present()
    shown_ball_x, shown_pad_x = ball_x, pad_x
end

local function hit(b)
    b.alive = false
    bricks_left = bricks_left - 1
    score = score + 10

    mark(b.x, B_W)          -- the ball covers only part of the brick
    score_dirty = true      -- redrawn later, when it fits in the strip
    play("brick")
end

local function move()
    if stuck then
        ball_x = pad_x + (PAD_W - BALL) / 2
        return
    end

    local nx, ny = ball_x + ball_vx, ball_y + ball_vy

    if nx < 0        then nx = 0;        ball_vx = -ball_vx; play("wall", 170) end
    if nx + BALL > W then nx = W - BALL; ball_vx = -ball_vx; play("wall", 170) end
    if ny < 30       then ny = 30;       ball_vy = -ball_vy; play("wall", 170) end

    if (ny + BALL >= pad_y) and (ny <= pad_y + PAD_H)
       and (nx + BALL >= pad_x) and (nx <= pad_x + PAD_W) and (ball_vy > 0) then
        ny = pad_y - BALL
        ball_vy = -ball_vy
        play("paddle")

        -- where the ball lands on the paddle changes the angle...
        local where = ((nx + BALL / 2) - (pad_x + PAD_W / 2)) / (PAD_W / 2)
        ball_vx = ball_vx + where * 2.0

        -- ...and a moving paddle drags the ball along
        ball_vx = ball_vx + pad_vx * 0.45

        -- keep the total speed fixed, or it grows with every hit
        local v = math.sqrt(ball_vx * ball_vx + ball_vy * ball_vy)
        local base = LEVELS[level].speed * 1.414
        if v > 0.01 then
            ball_vx, ball_vy = ball_vx * base / v, ball_vy * base / v
        end
    end

    for r = 1, ROWS do
        for c = 1, COLS do
            local b = wall[r][c]
            if b.alive and (nx + BALL > b.x) and (nx < b.x + B_W)
               and (ny + BALL > b.y) and (ny < b.y + B_H) then
                hit(b)
                ball_vy = -ball_vy
                ny = ball_y
                break
            end
        end
    end

    if ny > H then
        lives = lives - 1
        if lives <= 0 then
            play("over")
            over = true
            save_best(score)
        else
            play("life")
        end
        reset_ball()
        return
    end

    ball_x, ball_y = nx, ny
end

local function new_game()
    PAD_W = LEVELS[level].paddle
    pad_x = (W - PAD_W) / 2
    pad_y = H - 24
    score, lives, over = 0, 3, false

    -- The first sound powers up the audio chain, about 15 ms. Do it now,
    -- silently, instead of in the middle of the game.
    play("paddle", 0)

    build_wall()
    reset_ball()
    screen = "game"
    draw_all()
end

function init()
    local _, _, w, h = orion.sys.content_area()
    W, H = w, h
    orion.gfx.set_font(orion.gfx.system_font(0))
    orion.sys.set_fps(30)

    for name, file in pairs(SOUNDS) do
        sounds[name] = orion.audio.sfx_load("shared/sounds/" .. file .. ".wav")
    end

    level = orion.pref.get("level", 2)
    if (level < 1) or (level > #LEVELS) then level = 2 end

    PAD_W = LEVELS[level].paddle
    pad_x = (W - PAD_W) / 2
    pad_y = H - 24
    build_wall()
    reset_ball()
    draw_title()
end

local function update_title()
    for ev in orion.input.events() do
        if ev.kind == "down" then
            if ev.key == orion.K.ESC then orion.sys.exit(); return end
            if ev.key == orion.K.UP and level > 1 then
                level = level - 1; orion.pref.set("level", level); draw_title()
            end
            if ev.key == orion.K.DOWN and level < #LEVELS then
                level = level + 1; orion.pref.set("level", level); draw_title()
            end
            if ev.key == orion.K.ENTER then new_game(); return end
        end
    end
end

function update()
    if screen == "title" then return update_title() end

    for ev in orion.input.events() do
        if ev.kind == "down" then
            if ev.key == orion.K.ESC then
                screen = "title"; draw_title(); return
            end
            if ev.key == orion.K.ENTER then
                if over then
                    screen = "title"; draw_title(); return
                end
                stuck = false
            end
        end
    end

    if over then return end

    -- is_down, not events: movement needs the state of the key right now
    local before = pad_x
    if orion.input.is_down(orion.K.LEFT)  then pad_x = pad_x - 9 end
    if orion.input.is_down(orion.K.RIGHT) then pad_x = pad_x + 9 end
    if pad_x < 0 then pad_x = 0 end
    if pad_x + PAD_W > W then pad_x = W - PAD_W end
    pad_vx = pad_x - before

    dirty_x0, dirty_x1 = nil, nil
    move()

    if bricks_left == 0 then
        play("clear")
        build_wall()
        draw_all()
        return
    end
    if over then draw_all(); return end

    mark(math.min(shown_ball_x, ball_x), BALL  + math.abs(ball_x - shown_ball_x))
    mark(math.min(shown_pad_x, pad_x),   PAD_W + math.abs(pad_x - shown_pad_x))

    -- the score goes in only if the strip stays within the budget
    if score_dirty then
        local a = math.min(dirty_x0, -1)
        local b = math.max(dirty_x1, 172)
        if (b - a) <= MAX_COLUMNS then
            mark(0, 170)
            score_dirty = false
        end
    end

    local x0 = math.max(0, dirty_x0)
    local x1 = math.min(W, dirty_x1)
    draw_strip(x0, x1)

    -- If present_area says no, the strip did not reach the screen. Keep the
    -- old positions so the next strip covers this one too; otherwise moving
    -- objects leave trails.
    if orion.gfx.present_area(x0, 0, x1 - x0, H) then
        shown_ball_x, shown_pad_x = ball_x, pad_x
    end
end
