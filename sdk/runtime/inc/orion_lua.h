/**
 * @file    orion_lua.h
 * @brief   The Lua interpreter, and a benchmark comparing a heap in SRAM and
 *          in PSRAM.
 */
#ifndef ORION_LUA_H
#define ORION_LUA_H

#include "main.h"
#include "orion_api.h"
#include <stdbool.h>

typedef enum {
    ORION_LUA_SRAM = 0,   /* static arena in internal SRAM */
    ORION_LUA_PSRAM       /* arena in external PSRAM       */
} orion_lua_arena_t;

/** Opens a Lua state with its heap in the chosen arena, closing any previous one. */
bool orion_lua_apri(orion_lua_arena_t dove);
void orion_lua_chiudi(void);

/** The open state, or NULL. Declared with `struct lua_State` so this
 *  header does not need lua.h. */
struct lua_State;
struct lua_State *orion_lua_stato(void);

/** Adds the global `orion` table (orion_lua_bind.c). */
void orion_lua_bind(struct lua_State *L, const orion_api_t *api);

/** Runs a string; on error returns false and logs the message. */
bool orion_lua_esegui(const char *codice);

/** Bytes in use by the interpreter. */
int  orion_lua_memoria(void);

/** Benchmark: the same program with the heap in each memory. */
void orion_lua_bench(void);

/** The benchmark program alone, on the open state. */
void orion_lua_bench_una(void);

#endif /* ORION_LUA_H */
