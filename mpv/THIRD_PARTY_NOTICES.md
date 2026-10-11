# 内置播放器 第三方组件与许可证

KumiPlayer 的**内置播放器**是项目自带的 MPV（`mpv/runtime/` 27 个运行文件）加自有配置。当前仍为 `development-only`，公开安装包构建被拦截；材料完整并通过复核后才可随安装包分发。
本文件登记它的全部第三方组件、许可证与来源，供合规审阅与后续升级使用。

> 二进制本身不入 Git（见 `runtime-manifest.json` 与 `runtime/README.md`）；本文件与 `licenses/` 是必须随源码可见的合规材料。

## 1. 运行时组件（27 个文件）

来源：`mpv-v0.41.0-x86_64-w64-mingw32.zip`（MPV 官方 GitHub CI 构建，MinGW 版）。
**该构建启用 GPL 代码路径**（`mpv.com -v --version` 特性列表含 `gpl`；FFmpeg 构建配置含 `--enable-gpl`），因此运行时的主体按 **GPLv2+** 分发。

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
| thumbfast | MPL-2.0 | `licenses/thumbfast/MPL-2.0.txt` |
| Anime4K v4.0.1 | MIT | `licenses/anime4k-v4.0.1/LICENSE` |
| mpv-stats-zh | 本地保存 MIT 文本，历史授权证据待复核；派生部分 LGPL（见第 4 节） | `licenses/mpv-stats-zh/LICENSE.md` |
| uosc_danmaku | MIT | `licenses/uosc_danmaku/LICENSE` |

版本、来源 URL 与 SHA-256 统一登记在 `components-manifest.json`。

## 3. 对应源码（GPL 义务）

以下链接用于追溯上游，不能替代实际二进制的完整对应源码、补丁、依赖与构建记录：

- mpv：https://github.com/mpv-player/mpv/tree/v0.41.0
- 官方 Windows 构建脚本：https://github.com/mpv-player/mpv-winbuild-cmake
- FFmpeg：https://github.com/FFmpeg/FFmpeg
- 其余各组件上游地址见 `components-manifest.json` 与上表

正式发布采用随包提供已复核对应源码归档的方式，见 `SOURCE_CODE.txt` 与 `distribution-manifest.json`。当前尚无完整归档，也未作至少三年有效的书面源码提供承诺；仅列上游链接或通过 Issue 索取不能自动满足 GPLv2 第 3 节。

KumiPlayer 以独立进程 + MPV 原生 JSON IPC 驱动 `mpv.exe`，不链接 libmpv。这支持分别评估各程序的许可证，但是否构成聚合仍取决于通信语义与实际独立性，不能仅凭 IPC 宣称必然免责。保留现有架构，正式发布仍须完成组合关系与第三方许可复核。

依据：[MPV v0.41.0 Copyright](https://github.com/mpv-player/mpv/blob/v0.41.0/Copyright)、[FFmpeg 许可说明](https://ffmpeg.org/legal.html)、[GPLv2 第 3 节](https://www.gnu.org/licenses/old-licenses/gpl-2.0.html)、[GNU 聚合 FAQ](https://www.gnu.org/licenses/gpl-faq.en.html#MereAggregation)。

## 4. 待处理事项

- **mpv-stats-zh**：本地脚本 SHA-256 为 `4F037D83…2302`（2026-10-11 复算与清单一致），并保存了 MIT 文本。旧记录称它来自 2026-07-12、上游后续改许可，但当前清单只引用移动的 `main`，没有把脚本、历史 LICENSE 和同一不可变提交绑定；文件哈希相同不足以证明历史授权，发布复核仍未通过。该脚本派生自 mpv/Argon-/mpv-stats，须另核对原始 LGPL 义务。**不得凭本地 MIT 文本直接宣称可分发，升级前也必须重新评估许可。**
- **二进制对应源码**：27 个当前运行文件已复算 SHA-256，与 `runtime-manifest.json` 一致；原始 ZIP 哈希、完整构建提交、全部动态/静态依赖版本及构建源码归档仍未独立核实。
- **修改的脚本**：thumbfast 等含 KumiPlayer 修改；需核对准确上游版本、保留版权、许可与修改说明。`components-manifest.json` 中移动分支和空归档哈希不能当作已经完成的来源核验。
- **编解码专利**：H.264 / H.265 / AAC 等专利授权不由 GPL 覆盖，属独立事项，与是否使用 libmpv 无关。
