{
  "targets": [
    {
      "target_name": "native_fs",
      "sources": ["src/native_fs.cc"],
      "cflags_cc": ["-std=c++17"],
      "xcode_settings": {
        "CLANG_CXX_LANGUAGE_STANDARD": "c++17",
        "MACOSX_DEPLOYMENT_TARGET": "11.0"
      },
      "msvs_settings": {
        "VCCLCompilerTool": { "AdditionalOptions": ["/std:c++17"] }
      }
    }
  ]
}
