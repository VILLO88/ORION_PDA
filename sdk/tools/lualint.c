/* lualint: lists the globals a Lua script reads but never assigns.
   That catches two mistakes the parser does not see:
   - a misspelled global name;
   - a `local` used above the line that declares it, which Lua reads as a
     global and gets nil at run time.
   It compiles the script and walks the bytecode: a global access is
   GETTABUP/SETTABUP on the upvalue _ENV with a string constant as key. */
#include <stdio.h>
#include <string.h>
#include "lua.h"
#include "lauxlib.h"
#include "lobject.h"
#include "lopcodes.h"
#include "lstate.h"

static struct { char name[64]; int read, written; } seen[256];
static int n_seen;

static void note(const char *s, int write)
{
    int i;
    for (i = 0; i < n_seen; i++) if (strcmp(seen[i].name, s) == 0) break;
    if (i == n_seen)
    {
        if (n_seen >= 256) return;
        snprintf(seen[n_seen].name, 64, "%s", s);
        seen[n_seen].read = seen[n_seen].written = 0;
        n_seen++;
    }
    if (write) seen[i].written = 1; else seen[i].read = 1;
}

/* What a script may read without defining it: the orion module and the
   standard libraries the device loads (no io, os, package or debug). */
static const char *KNOWN[] = {
    "orion", "print", "type", "tostring", "tonumber", "pairs", "ipairs",
    "next", "select", "error", "assert", "pcall", "xpcall", "rawget",
    "rawset", "rawequal", "rawlen", "setmetatable", "getmetatable",
    "unpack", "require", "collectgarbage", "load",
    "math", "string", "table", "coroutine", "utf8", "_G", "_VERSION", NULL
};

static int known(const char *s)
{
    for (int i = 0; KNOWN[i]; i++) if (strcmp(KNOWN[i], s) == 0) return 1;
    return 0;
}

static void walk(const Proto *f)
{
    for (int i = 0; i < f->sizecode; i++)
    {
        const Instruction in = f->code[i];
        const OpCode op = GET_OPCODE(in);

        /* The two opcodes order their operands differently:
           GETTABUP A B C = R[A] := UpVal[B][K[C]]
           SETTABUP A B C = UpVal[A][K[B]] := RK[C] */
        int up = -1, key = -1;
        if      (op == OP_GETTABUP) { up = GETARG_B(in); key = GETARG_C(in); }
        else if (op == OP_SETTABUP) { up = GETARG_A(in); key = GETARG_B(in); }
        else continue;

        if ((up < f->sizeupvalues) && f->upvalues[up].name &&
            (strcmp(getstr(f->upvalues[up].name), "_ENV") == 0) &&
            (key < f->sizek) && ttisstring(&f->k[key]))
            note(getstr(tsvalue(&f->k[key])), (op == OP_SETTABUP));
    }
    for (int i = 0; i < f->sizep; i++) walk(f->p[i]);
}

int main(int argc, char **argv)
{
    if (argc < 2) { fprintf(stderr, "usage: lualint <file.lua>\n"); return 2; }

    lua_State *L = luaL_newstate();
    if (luaL_loadfile(L, argv[1]) != LUA_OK)
    {
        fprintf(stderr, "%s\n", lua_tostring(L, -1));
        return 1;
    }
    walk(clLvalue(s2v(L->top.p - 1))->p);

    int found = 0;
    for (int i = 0; i < n_seen; i++)
    {
        if (seen[i].read && !seen[i].written && !known(seen[i].name))
        {
            printf("%s: global read but never assigned: %s\n",
                   argv[1], seen[i].name);
            found++;
        }
    }
    if (found == 0) printf("%s: ok\n", argv[1]);
    return (found > 0) ? 1 : 0;
}

/* The hooks the firmware provides on the device (see luaconf.h). The seed
   is fixed so the result is the same every time. */
void     orion_lua_scrivi(const char *s, size_t n) { fwrite(s, 1, n, stdout); }
void     orion_lua_errore(const char *fmt, const char *arg) { fprintf(stderr, fmt, arg); }
unsigned orion_lua_seed(void) { return 0u; }
