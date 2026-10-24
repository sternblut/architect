// Host helper that reports when the Mac goes to sleep and wakes (IORegisterForSystemPower).
// stdout: "sleep N"  the Mac is going to sleep; sleep waits up to 20 s for "ok N" on stdin (the relay has the bot)
//         "wake"     the Mac woke up (the host checks whether it is a full wake)
// Exits when stdin closes, i.e. the host is gone. Build: swiftc -O powerwatch.swift -o powerwatch (src/relay.ts does it).
import Foundation
import IOKit.pwr_mgt

// iokit_common_msg(…) values from IOKit/IOMessage.h, whose macros Swift can't see
let canSystemSleep: UInt32 = 0xE000_0270
let systemWillSleep: UInt32 = 0xE000_0280
let systemHasPoweredOn: UInt32 = 0xE000_0300

var root: io_connect_t = 0
var seq = 0
var okSeq = 0
let okReady = NSCondition()

func say(_ s: String) {
  FileHandle.standardOutput.write(Data((s + "\n").utf8))
}

Thread {
  while let line = readLine() {
    if line.hasPrefix("ok "), let n = Int(line.dropFirst(3)) {
      okReady.lock()
      okSeq = max(okSeq, n)
      okReady.broadcast()
      okReady.unlock()
    }
  }
  exit(0)
}.start()

var port: IONotificationPortRef?
var notifier: io_object_t = 0
root = IORegisterForSystemPower(nil, &port, { _, _, type, arg in
  switch type {
  case canSystemSleep:
    IOAllowPowerChange(root, Int(bitPattern: arg))
  case systemWillSleep:
    seq += 1
    say("sleep \(seq)")
    let deadline = Date().addingTimeInterval(20)
    okReady.lock()
    while okSeq < seq && okReady.wait(until: deadline) {}
    okReady.unlock()
    IOAllowPowerChange(root, Int(bitPattern: arg))
  case systemHasPoweredOn:
    say("wake")
  default:
    break
  }
}, &notifier)
guard root != 0, let port else {
  FileHandle.standardError.write(Data("IORegisterForSystemPower failed\n".utf8))
  exit(1)
}
CFRunLoopAddSource(CFRunLoopGetCurrent(), IONotificationPortGetRunLoopSource(port).takeUnretainedValue(), .defaultMode)
CFRunLoopRun()
