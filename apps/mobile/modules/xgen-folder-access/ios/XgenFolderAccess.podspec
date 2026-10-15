Pod::Spec.new do |s|
  s.name           = 'XgenFolderAccess'
  s.version        = '1.0.0'
  s.summary        = 'Folders the user connects to a conversation (picker + security-scoped bookmarks).'
  s.description    = 'Presents the system folder picker and keeps access to the chosen folders across launches.'
  s.author         = 'PlateerLab'
  s.homepage       = 'https://github.com/PlateerLab/xgen-dex-core'
  s.license        = 'Apache-2.0'
  s.platforms      = { :ios => '15.1' }
  s.source         = { git: '' }
  s.static_framework = true
  s.swift_version  = '5.4'

  s.dependency 'ExpoModulesCore'

  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }

  s.source_files = "**/*.{h,m,swift}"
end
