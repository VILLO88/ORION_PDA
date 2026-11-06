// Legge il Calendario del Mac e stampa JSON su stdout.
//
// ⚠️ Perche' un eseguibile separato e non un modulo nativo di Node: la lezione
// del BLE era "niente moduli da ricompilare a ogni versione di Electron", e
// quel problema e' l'**ABI di Node**, non il codice nativo. Un binario che
// parla JSON non ha nessuna ABI in comune con Electron — si ricompila quando
// cambia macOS, non quando cambia Electron.
//
// ⚠️ Le ricorrenze le espande **EventKit**, non noi: `events(matching:)` torna
// le occorrenze gia' srotolate dentro l'intervallo chiesto. E' l'intero motivo
// per cui il dispositivo puo' essere stupido (vedi CALENDARIO.md §2).
//
//   ./calendario --permesso
//   ./calendario --calendari
//   ./calendario --eventi 2026-09-01 2026-12-31 [id...]
//
// Senza id, `--eventi` prende tutti i calendari.

import Foundation
import EventKit

let store = EKEventStore()

func esci(_ oggetto: Any) -> Never {
    let dati = try! JSONSerialization.data(withJSONObject: oggetto,
                                           options: [.sortedKeys])
    FileHandle.standardOutput.write(dati)
    FileHandle.standardOutput.write("\n".data(using: .utf8)!)
    exit(0)
}

func errore(_ messaggio: String) -> Never {
    esci(["ok": false, "errore": messaggio])
}

/// ⚠️ Il permesso e' asincrono e il processo morirebbe prima della risposta:
/// serve un semaforo. E su macOS 14 il metodo e' cambiato nome — chiedere
/// quello vecchio da' "accesso negato" senza mostrare nessun pannello.
func chiediPermesso() -> Bool {
    var concesso = false
    let attesa = DispatchSemaphore(value: 0)

    if #available(macOS 14.0, *) {
        store.requestFullAccessToEvents { ok, _ in concesso = ok; attesa.signal() }
    } else {
        store.requestAccess(to: .event) { ok, _ in concesso = ok; attesa.signal() }
    }
    // Se l'utente non risponde, non si resta appesi per sempre.
    _ = attesa.wait(timeout: .now() + 60)
    return concesso
}

/// ⚠️ Si guarda il **numero** e non i casi con il nome: macOS 14 ha aggiunto
/// `.fullAccess` (3, lo stesso valore di `.authorized`) e `.writeOnly` (4), e
/// un `switch` sui nomi non compila uguale a seconda dell'SDK con cui lo si
/// costruisce. Col numero il comportamento e' lo stesso ovunque.
///
/// ⚠️ E **4 non basta**: "solo scrittura" permette di creare eventi, non di
/// leggerli. Trattarlo come un si' darebbe un calendario vuoto senza dire
/// perche'.
func statoPermesso() -> String {
    switch EKEventStore.authorizationStatus(for: .event).rawValue {
    case 0:  return "da chiedere"
    case 1:  return "vietato dal sistema"
    case 2:  return "negato"
    case 3:  return "ok"
    case 4:  return "solo scrittura"
    default: return "sconosciuto"
    }
}

let iso: DateFormatter = {
    let f = DateFormatter()
    f.dateFormat = "yyyy-MM-dd"
    f.timeZone = TimeZone.current
    return f
}()

let isoOra: DateFormatter = {
    let f = DateFormatter()
    // ⚠️ Ora **locale**, senza fuso: e' quella che finisce nel file, e il
    // dispositivo non sa cosa sia un fuso orario. Vedi CALENDARIO.md §3.
    f.dateFormat = "yyyy-MM-dd'T'HH:mm"
    f.timeZone = TimeZone.current
    return f
}()

let argomenti = Array(CommandLine.arguments.dropFirst())
guard let comando = argomenti.first else {
    errore("uso: --permesso | --calendari | --eventi <da> <a> [id...]")
}

switch comando {

case "--permesso":
    let prima = statoPermesso()
    let ok = (prima == "ok") ? true : chiediPermesso()
    esci(["ok": ok, "stato": statoPermesso(), "prima": prima])

case "--calendari":
    guard statoPermesso() == "ok" || chiediPermesso() else {
        errore("nessun accesso al Calendario (stato: \(statoPermesso()))")
    }
    let elenco = store.calendars(for: .event).map { c -> [String: Any] in
        var colore = ""
        if let cg = c.cgColor, let comp = cg.components, comp.count >= 3 {
            colore = String(format: "#%02X%02X%02X",
                            Int(comp[0] * 255), Int(comp[1] * 255), Int(comp[2] * 255))
        }
        return [
            "id": c.calendarIdentifier,
            "nome": c.title,
            "conto": c.source?.title ?? "",
            "colore": colore,
            "scrivibile": c.allowsContentModifications,
        ]
    }
    esci(["ok": true, "calendari": elenco])

case "--eventi":
    guard argomenti.count >= 3,
          let da = iso.date(from: argomenti[1]),
          let a  = iso.date(from: argomenti[2]) else {
        errore("date non valide: servono due yyyy-MM-dd")
    }
    guard statoPermesso() == "ok" || chiediPermesso() else {
        errore("nessun accesso al Calendario (stato: \(statoPermesso()))")
    }

    let scelti = Array(argomenti.dropFirst(3))
    let tutti  = store.calendars(for: .event)
    let quali  = scelti.isEmpty ? tutti
                                : tutti.filter { scelti.contains($0.calendarIdentifier) }
    if quali.isEmpty { errore("nessuno dei calendari indicati esiste piu'") }

    // Fino a fine giornata del giorno "a".
    let fine = Calendar.current.date(byAdding: .day, value: 1, to: a) ?? a
    let predicato = store.predicateForEvents(withStart: da, end: fine,
                                             calendars: quali)

    let eventi = store.events(matching: predicato)
        .filter { $0.status != .canceled }
        .sorted { $0.startDate < $1.startDate }
        .map { e -> [String: Any] in
            [
                "titolo": e.title ?? "",
                "luogo": e.location ?? "",
                "calendario": e.calendar.title,
                "inizio": isoOra.string(from: e.startDate),
                "fine": isoOra.string(from: e.endDate),
                "giornoIntero": e.isAllDay,
            ]
        }

    esci(["ok": true, "eventi": eventi, "calendari": quali.map { $0.title }])

default:
    errore("comando sconosciuto: \(comando)")
}
