/**
 * @file  shim/audio_sfx.h
 * @brief Short sounds as seen by app_host.c. On the device audio_sfx_reset()
 *        stops the voices before the app memory holding their samples is
 *        freed; the emulator's sound lives in emu_audio.c.
 */
#ifndef AUDIO_SFX_H
#define AUDIO_SFX_H

static inline void audio_sfx_reset(void) { }

#endif /* AUDIO_SFX_H */
