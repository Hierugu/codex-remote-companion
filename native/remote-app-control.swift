import AppKit
import Foundation

private let bundleIDs = [
    "vscode": "com.microsoft.VSCode",
    "codex": "com.openai.codex"
]

private func running(_ target: String) -> [NSRunningApplication] {
    guard let bundleID = bundleIDs[target] else { return [] }
    return NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
}

private func writeResult(_ value: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.sortedKeys]),
          let text = String(data: data, encoding: .utf8) else {
        fputs("Could not encode app status\n", stderr)
        exit(1)
    }
    print(text)
}

let arguments = Array(CommandLine.arguments.dropFirst())
guard let command = arguments.first else {
    fputs("Usage: remote-app-control status|quit [vscode] [codex]\n", stderr)
    exit(2)
}

switch command {
case "status":
    guard arguments.count == 1 else { exit(2) }
    writeResult(["vscode": !running("vscode").isEmpty, "codex": !running("codex").isEmpty])
case "quit":
    let targets = Array(arguments.dropFirst())
    guard !targets.isEmpty && Set(targets).count == targets.count &&
          targets.allSatisfy({ bundleIDs[$0] != nil }) else { exit(2) }

    var requested: [String: Bool] = [:]
    for target in targets {
        let applications = running(target)
        let results = applications.map { $0.terminate() }
        requested[target] = results.allSatisfy { $0 }
    }

    let deadline = Date().addingTimeInterval(12)
    while Date() < deadline && targets.contains(where: { !running($0).isEmpty }) {
        RunLoop.current.run(until: Date().addingTimeInterval(0.2))
    }
    var exited: [String: Bool] = [:]
    for target in targets { exited[target] = running(target).isEmpty }
    writeResult(["requested": requested, "exited": exited])
default:
    exit(2)
}
