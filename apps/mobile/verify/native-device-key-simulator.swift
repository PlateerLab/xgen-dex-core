import UIKit

/** Opt-in simulator-only harness. It never substitutes a software key or calls a server. */
@UIApplicationMain
final class NativeKeyGateApp: UIResponder, UIApplicationDelegate {
  var window: UIWindow?
  func application(_ application: UIApplication, didFinishLaunchingWithOptions options: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
    #if targetEnvironment(simulator)
    let keys = HardwareDeviceKey(); var rejected = 0
    for create in [false, true] {
      do { _ = try keys.prepare("https://xgen.example.test", "7", create); fatalError("Simulator created a device key") }
      catch DeviceKeyFailure.unavailable { rejected += 1 } catch { fatalError("Unexpected native key failure") }
    }
    do { _ = try keys.sign("https://xgen.example.test", "7", "fixture", "fixture", "register", DeviceProof.encode(Data(repeating: 5, count: 32))); fatalError("Simulator signed a device proof") }
    catch DeviceKeyFailure.unavailable { rejected += 1 } catch { fatalError("Unexpected native sign failure") }
    precondition(rejected == 3)
    let root = FileManager.default.urls(for: .documentDirectory, in: .userDomainMask)[0]
    try! Data("{\"passed\":true,\"rejected\":3,\"software_fallback\":false}".utf8).write(to: root.appendingPathComponent("native-key-result.json"))
    let view = UIViewController(); view.view.backgroundColor = .systemBackground
    let label = UILabel(); label.numberOfLines = 0; label.textAlignment = .center; label.textColor = .label
    label.text = "기기 키 검증 통과\n\n시뮬레이터 키 생성·조회·서명 차단\n소프트웨어 키 대체 없음"
    label.translatesAutoresizingMaskIntoConstraints = false; view.view.addSubview(label)
    NSLayoutConstraint.activate([label.centerXAnchor.constraint(equalTo: view.view.centerXAnchor), label.centerYAnchor.constraint(equalTo: view.view.centerYAnchor), label.widthAnchor.constraint(equalTo: view.view.widthAnchor, constant: -40)])
    window = UIWindow(frame: UIScreen.main.bounds); window?.rootViewController = view; window?.makeKeyAndVisible()
    return true
    #else
    fatalError("This disposable harness is simulator-only")
    #endif
  }
}
