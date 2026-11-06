/* the device console is stdout here */
#ifndef EMU_USB_CDC_H
#define EMU_USB_CDC_H
void usb_cdc_printf(const char *fmt, ...);
void usb_cdc_task(void);
#endif
