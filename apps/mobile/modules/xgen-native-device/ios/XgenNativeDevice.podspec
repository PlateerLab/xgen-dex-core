require 'json'
package = JSON.parse(File.read(File.join(__dir__, '..', 'package.json')))
Pod::Spec.new do |s|
  s.name = 'XgenNativeDevice'
  s.version = package['version']
  s.summary = package['description']
  s.description = package['description']
  s.license = package['license']
  s.author = package['author']
  s.homepage = package['homepage']
  s.platforms = { :ios => '15.1' }
  s.swift_version = '5.4'
  s.source = { git: package['homepage'] }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.frameworks = 'Security', 'CryptoKit'
  s.source_files = '**/*.swift'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
end
