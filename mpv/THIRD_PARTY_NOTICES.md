# 内置播放器 第三方组件与许可证

KumiPlayer 的**内置播放器**是项目自带的 MPV（`mpv/runtime/` 27 个运行文件）加自有配置。当前仍为 `development-only`，公开安装包构建被拦截；材料完整并通过复核后才可随安装包分发。
本文件登记它的全部第三方组件、许可证与来源，供合规审阅与后续升级使用。

> 二进制本身不入 Git（见 `runtime-manifest.json` 与 `runtime/README.md`）；本文件与 `licenses/` 是必须随源码可见的合规材料。

## 1. 运行时组件（27 个文件）

来源：`mpv-v0.41.0-x86_64-w64-mingw32.zip`（MPV 官方 GitHub CI 构建，MinGW 版）。
**该构建启用 GPL 代码路径**：当前 FFmpeg DLL 的 `avcodec_configuration()` 含 `--enable-gpl`，`avcodec_license()` 返回 GPL version 2 or later；与准确 MPV 提交的官方 CI 配置一致。运行时主体按 **GPLv2+** 准备分发材料，不将版本输出误写为已核验的特性列表。

2026-10-11 已重新下载原始官方 ZIP 并复算 SHA-256，27 个运行文件均与其嵌套 ZIP 一致。MPV 完整提交为 `41f6a645068483470267271e1d09966ca3b9f413`，FFmpeg 为 `1fcb201ab10cbc98d931e340da6ace292e82b1e1`。实际来源、构建配置和未确认的依赖见 `provenance/runtime.json`、`sources/runtime-inputs.json`。

| 组件 | 随包文件 | 许可证 | 许可证正文 |
|---|---|---|---|
| mpv v0.41.0 | `mpv.exe`、`mpv.com`、`mpv-register.bat`、`mpv-unregister.bat` | GPL-2.0-or-later | `licenses/mpv-v0.41.0/LICENSE.GPL` |
| FFmpeg（git-2025-12-21） | `avcodec-62`、`avdevice-62`、`avfilter-11`、`avformat-62`、`avutil-60`、`swresample-6`、`swscale-9`（.dll） | GPL-2.0-or-later | `licenses/ffmpeg/COPYING.GPLv2`、`licenses/ffmpeg/LICENSE.md` |
| libass | `libass-9.dll` | ISC | `licenses/libass/COPYING` |
| dav1d | `libdav1d.dll` | BSD-2-Clause | `licenses/dav1d/COPYING` |
| libplacebo | `libplacebo-358.dll` | LGPL-2.1-or-later | `licenses/libplacebo/LICENSE` |
| GNU FriBidi | `libfribidi-0.dll` | LGPL-2.1-or-later | `licenses/fribidi/COPYING` |
| GNU libiconv | `libiconv-2.dll` | LGPL-2.1-or-later | `licenses/libiconv/COPYING.LIB` |
| FreeType | `libfreetype-6.dll` | FTL 或 GPLv2（双许可） | `licenses/freetype/LICENSE.TXT`、`licenses/freetype/FTL.TXT` |
| HarfBuzz | `libharfbuzz-0.dll` | MIT | `licenses/harfbuzz/COPYING` |
| Little CMS | `liblcms2.dll` | MIT | `licenses/lcms2/LICENSE` |
| shaderc | `libshaderc_shared.dll` | Apache-2.0 | `licenses/shaderc/LICENSE` |
| SPIRV-Cross | `libspirv-cross-c-shared.dll` | Apache-2.0 | `licenses/spirv-cross/LICENSE` |
| Vulkan-Loader | `vulkan-1.dll` | Apache-2.0 | `licenses/vulkan-loader/LICENSE.txt` |
| zlib | `zlib1.dll` | Zlib | `licenses/zlib/LICENSE` |
| GCC 运行库 | `libgcc_s_seh-1.dll`、`libssp-0.dll`、`libstdc++-6.dll` | GPL-3.0 **+ GCC Runtime Library Exception** | `licenses/gcc-runtime/COPYING3`、`licenses/gcc-runtime/COPYING.RUNTIME` |
| mingw-w64 运行库 | `libwinpthread-1.dll` | mingw-w64 许可 | `licenses/mingw-w64/COPYING` |
| LuaJIT | 静态链入 `mpv.exe` | MIT | `licenses/luajit/COPYRIGHT` |
| mujs | 静态链入 `mpv.exe` | ISC | `licenses/mujs/COPYING` |

## 2. 播放增强组件（配置层，随包分发）

| 组件 | 许可证 | 许可证正文 |
|---|---|---|
| uosc 5.13.0 | LGPL-2.1 | `licenses/uosc-5.13.0/LICENSE.LGPL` |
| Material Icons Round（uosc_icons.otf） | Apache-2.0，Copyright 2019 Google LLC | `licenses/material-icons-round/LICENSE` |
| thumbfast | MPL-2.0 | `licenses/thumbfast/MPL-2.0.txt` |
| Anime4K v4.0.1 | MIT | `licenses/anime4k-v4.0.1/LICENSE` |
| mpv-stats-zh | 同提交 MIT 与 README 非商用声明有冲突；继承部分保留 LGPL/GPL（见第 4 节） | `licenses/mpv-stats-zh/LICENSE.md`、`licenses/mpv-v0.41.0/LICENSE.LGPL`、`LICENSE.GPL` |
| uosc_danmaku | MIT | `licenses/uosc_danmaku/LICENSE` |

版本、来源 URL 与 SHA-256 统一登记在 `components-manifest.json`。`sources/evidence/components/` 保存准确源码、原许可、当前修改源码及补丁；thumbfast 和弹幕补丁已重建验证。uosc、Anime4K 随包文件与准确上游字节一致。图标字体另追溯至 Google 提交 `1c575764826fa5752ddc2bdc6b31ef7cc3233371`，不以 uosc 的 LGPL 替代字体 Apache 许可。

## 3. 对应源码（GPL 义务）

以下链接用于追溯上游，不能替代实际二进制的完整对应源码、补丁、依赖与构建记录：

- mpv：https://github.com/mpv-player/mpv/tree/v0.41.0
- 本二进制实际官方构建脚本：https://github.com/mpv-player/mpv/blob/41f6a645068483470267271e1d09966ca3b9f413/ci/build-mingw64.sh
- FFmpeg：https://github.com/FFmpeg/FFmpeg
- 其余各组件上游地址见 `components-manifest.json` 与上表

正式发布采用随包提供已复核对应源码归档的方式，见 `SOURCE_CODE.txt` 与 `distribution-manifest.json`。已保存 9 份已证实运行时源码输入、配置组件源码和修改补丁及实际 CI 脚本；`sources/mpv-provenance-evidence.zip` 明确标记为来源证据，尚不是完整对应源码。Anime4K 轻量源码档案只排除应用不分发的比较演示图片，保留全部源码、模型和生成资料。完整源码闭包仍未确认，也未作至少三年有效的书面源码提供承诺；仅列上游链接或通过 Issue 索取不能自动满足 GPLv2 第 3 节。本地生成源码档案也不等于已向公众交付。

KumiPlayer 以独立进程 + MPV 原生 JSON IPC 驱动 `mpv.exe`，不链接 libmpv。这支持分别评估各程序的许可证，但是否构成聚合仍取决于通信语义与实际独立性，不能仅凭 IPC 宣称必然免责。保留现有架构，正式发布仍须完成组合关系与第三方许可复核。

依据：[MPV v0.41.0 Copyright](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright)、[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[GPLv2 第 3 节](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)、[GNU 聚合 FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)。

## 4. 待处理事项

- **mpv-stats-zh**：本地 SHA-256 `4F037D83…2302` 精确匹配提交 `53b087e81d21bf6f5f376340b94d4184a7de9a19`；同提交 LICENSE 是 MIT，README 已含禁止商用声明。限制首次引入于 2026-07-05，不能描述为当前脚本之后才出现。该提交完整源码、许可、README 和 MPV/Argon 父源码许可已归档，见 `sources/evidence/stats/EVIDENCE.txt`。2026-06-30 旧版没有此冲突，但缺少系统 CPU/GPU 增强；按用户意愿保留新版，需澄清其额外条款，不能直接宣布许可通过。自愿赞助与项目开源不能自动消除第三方授权矛盾。
- **二进制对应源码**：ZIP、27 个运行文件及已证实输入完成核对；官方脚本对部分依赖 clone 浮动分支，GitHub 历史日志已删除（HTTP 410）。仍缺 libass、lcms2、libplacebo、shaderc 及其静态依赖、SPIRV-Cross、nv-codec-headers、Vulkan Headers/Loader 准确 checkout、mujs WrapDB 和工具链记录。取得原始构建材料或另行授权进行固定依赖的受控重建后才能完成源码闭包，不能据临近提交日期推测为准确版本。
- **发布复核**：已解决脚本出处、修改补丁和字体许可遗漏，但完整源码与当前统计脚本授权仍有明确缺项，保留 development-only。审核人及全部发布文件 SHA-256 须在材料真正齐全后填写。
- **编解码专利**：H.264 / H.265 / AAC 等专利授权不由 GPL 覆盖，属独立事项，与是否使用 libmpv 无关。
