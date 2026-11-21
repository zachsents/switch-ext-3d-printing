import SwiftUI

@main
struct PrintingApp: App {
  @Environment(\.scenePhase) private var phase
  @State private var model = Model()

  var body: some Scene {
    WindowGroup {
      NavigationStack(path: $model.path) {
        PrintersView(model: model)
          .navigationDestination(for: Route.self) { route in
            switch route {
            case .printer(let id): PrinterView(model: model, id: id)
            }
          }
      }
      .tint(SIS.ink)
      .preferredColorScheme(.dark)
      .onOpenURL { model.open(url: $0) }
    }
    .onChange(of: phase) { _, now in
      model.active = now == .active
      if now == .active { model.core.wake() }
    }
  }
}

enum Route: Hashable {
  case printer(String)
}

/// One AMS slot, or the external spool (`ext`).
struct Slot: Identifiable, Hashable {
  let slot: String
  let loaded: Bool
  let type: String
  let color: String
  let brand: String
  let active: Bool
  let rfid: Bool
  var id: String { slot }
}

/// A printer as `status` gives it.
struct Printer: Identifiable, Hashable {
  let id: String
  let name: String
  let model: String
  let online: Bool
  let phase: String
  let stage: String
  let file: String
  let percent: Int
  let layer: Int
  let layers: Int
  let endsAt: Date?
  let nozzle: Int
  let nozzleTarget: Int
  let bed: Int
  let bedTarget: Int
  let slots: [Slot]
  let errors: [String]

  init(_ j: JSON) {
    id = j["id"].str
    name = j["name"].str
    model = j["model"].str
    online = j["online"].bool == true
    phase = j["phase"].str
    stage = j["stage"].str
    file = j["file"].str
    percent = Int(j["percent"].number ?? 0)
    layer = Int(j["layer"].number ?? 0)
    layers = Int(j["layers"].number ?? 0)
    endsAt = j["endsAt"].number.map { Date(timeIntervalSince1970: $0 / 1000) }
    nozzle = Int((j["nozzle"].number ?? 0).rounded())
    nozzleTarget = Int((j["nozzleTarget"].number ?? 0).rounded())
    bed = Int((j["bed"].number ?? 0).rounded())
    bedTarget = Int((j["bedTarget"].number ?? 0).rounded())
    let ams = j["slots"].array.map {
      Slot(
        slot: $0["slot"].str, loaded: $0["loaded"].bool == true, type: $0["type"].str, color: $0["color"].str, brand: $0["brand"].str,
        active: $0["active"].bool == true, rfid: $0["rfid"].bool == true)
    }
    let spool = j["spool"]
    slots =
      ams.isEmpty
      ? [Slot(slot: "ext", loaded: !spool.isNull, type: spool["type"].str, color: spool["color"].str, brand: spool["brand"].str, active: false, rfid: false)]
      : ams
    errors = j["errors"].array.map { $0["text"].string ?? $0["code"].str }.filter { !$0.isEmpty }
  }

  var active: Bool { ["printing", "preparing", "paused"].contains(phase) }
}

/// The app: the core, where the user is, and the printers as last read (`status`), read again on
/// each of the extension's events and every few seconds while the app's in front.
@MainActor @Observable
final class Model {
  let core = Core(app: "printers")
  var path: [Route] = []
  private(set) var printers: [Printer] = []
  var problem: String?
  var active = true

  init() {
    core.on(
      [
        "printers.state_changed", "printers.job_started", "printers.job_progress", "printers.job_finished", "printers.job_failed",
        "printers.filament_ran_out", "printers.error", "printers.slots_changed",
      ]
    ) { [weak self] _, _ in Task { await self?.load() } }
    core.start()
    Task {
      while true {
        if active { await load() }
        try? await Task.sleep(for: .seconds(5))
      }
    }
    // A page to open at launch (`-open switch-printing://printer/<id>`), as a link would.
    if let link = UserDefaults.standard.string(forKey: "open"), let url = URL(string: link) { open(url: url) }
  }

  func open(url: URL) {
    let id = url.pathComponents.dropFirst().first ?? ""
    if url.host() == "printer", !id.isEmpty { path = [.printer(id)] }
  }

  func load() async {
    do {
      printers = try await core.call("status")["printers"].array.map(Printer.init)
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
  }

  /// A tool on one printer; what it says went wrong shows on the page.
  func act(_ tool: String, _ args: [String: JSON]) async {
    do {
      _ = try await core.call(tool, .object(args))
      problem = nil
    } catch {
      problem = error.localizedDescription
    }
    await load()
  }
}
