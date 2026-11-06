/**
 * Key codes and the event queue of the keyboard driver. The enum and the
 * struct must match the firmware's keyboard.h exactly.
 */
#ifndef EMU_KEYBOARD_H
#define EMU_KEYBOARD_H
#include <stdint.h>
#include <stdbool.h>

enum {
  KEY_NONE   = 0x00,
  KEY_ESC    = 0xA0,
  KEY_RW, KEY_PLAY, KEY_FW, KEY_MUTE, KEY_VOLDN, KEY_VOLUP,
  KEY_SAVE, KEY_SEARCH,
  KEY_BACK, KEY_ENTER, KEY_DEL, KEY_MENU,
  KEY_UP, KEY_DOWN, KEY_LEFT, KEY_RIGHT,
  KEY_SHIFT, KEY_FN
};

typedef struct {
  uint8_t code;      /* ASCII, or one of the KEY_* above  */
  uint8_t raw;       /* raw TCA8418 code, 1..60          */
  bool    pressed;   /* true = pressed, false = released */
} key_event_t;

bool keyboard_poll(key_event_t *ev);
bool keyboard_is_down(uint8_t code);
bool keyboard_shift(void);
bool keyboard_fn(void);
#endif
