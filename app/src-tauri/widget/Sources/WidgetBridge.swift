import Foundation
import WidgetKit

/// The in-process WidgetKit bridge the Rust host loads with `dlopen`.
///
/// `chronod` accepts `WidgetCenter` calls only from the process whose
/// executable is the bundle's `CFBundleExecutable`. A helper executable inside
/// the same bundle is rejected, which is why configuration stayed unknown and
/// timeline reloads never landed. This dylib is loaded into the host app's own
/// process, so the calls carry the app's identity.

private let queryTimeout: TimeInterval = 5

private final class QueryResult {
    private let lock = NSLock()
    private var storage: String?

    func set(_ value: String) {
        lock.lock()
        storage = value
        lock.unlock()
    }

    func get() -> String? {
        lock.lock()
        defer { lock.unlock() }
        return storage
    }
}

/// Writes `{"configured":bool|null,"configuredKinds":[…]}` into `out`.
///
/// `configured` answers for the requested `kind`; `kinds` lists every
/// configured kind of this app. Returns the number of bytes written, or `-1`
/// when the buffer is too small. A `configured` of `null` covers every
/// failure: a timed-out query must read as unknown, never as "not configured".
@_cdecl("agentgauge_widget_status")
public func agentgauge_widget_status(
    kind: UnsafePointer<CChar>,
    out: UnsafeMutablePointer<CChar>,
    capacity: Int32
) -> Int32 {
    let kindName = String(cString: kind)
    let result = QueryResult()
    let semaphore = DispatchSemaphore(value: 0)

    WidgetCenter.shared.getCurrentConfigurations { configurations in
        switch configurations {
        case .success(let widgets):
            // `kinds` carries every configured kind of this app, not just the
            // requested one: the Dev and Release builds place separate widgets,
            // and each build must know an AgentGauge widget already exists.
            let kinds = widgets.map(\.kind)
            let payload: [String: Any] = [
                "configured": kinds.contains(kindName),
                "configuredKinds": kinds,
            ]
            if let data = try? JSONSerialization.data(withJSONObject: payload) {
                result.set(String(decoding: data, as: UTF8.self))
            } else {
                result.set("{\"configured\":null,\"configuredKinds\":[]}")
            }
        case .failure:
            result.set("{\"configured\":null,\"configuredKinds\":[]}")
        }
        semaphore.signal()
    }

    if semaphore.wait(timeout: .now() + queryTimeout) == .timedOut {
        result.set("{\"configured\":null}")
    }

    guard let json = result.get() else { return -1 }
    let bytes = Array(json.utf8)
    guard bytes.count + 1 <= Int(capacity) else { return -1 }
    bytes.withUnsafeBufferPointer { buffer in
        _ = memcpy(out, buffer.baseAddress, bytes.count)
    }
    out[bytes.count] = 0
    return Int32(bytes.count)
}

/// Asks WidgetKit to reload every timeline of this app's widgets.
///
/// Best-effort by contract: WidgetKit coalesces or defers reloads on its own
/// schedule, so a returned `true` means "the request was made", never "the
/// widget re-rendered".
@_cdecl("agentgauge_widget_reload")
public func agentgauge_widget_reload() -> Bool {
    WidgetCenter.shared.reloadAllTimelines()
    return true
}
