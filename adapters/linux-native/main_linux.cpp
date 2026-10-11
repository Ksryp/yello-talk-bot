/**
 * GME Music Bot - Companion service for YelloTalk bot (Linux version)
 * Joins a Tencent GME voice room and plays music via StartAccompany
 *
 * THREADING: GME SDK requires all calls on the main thread.
 * HTTP thread only parses requests and queues commands.
 * Main thread loop processes commands + calls Poll().
 *
 * SDK LOADING: On Linux, the GME SDK (.so files from Android) are loaded
 * at runtime via dlopen(), NOT linked at compile time. This ensures main()
 * starts safely and we get proper error messages if loading fails.
 *
 * Controlled via HTTP (default port 9876, override with --port):
 *   POST /join    {"room": "gme_room_id", "user": "numeric_gme_id", "uuid": "real_uuid"}
 *   POST /play    {"file": "path/to/song.mp3", "loop": true}
 *   POST /stop
 *   POST /pause
 *   POST /resume
 *   POST /volume  {"vol": 100}
 *   POST /room-quality {"quality": "fluency|standard|highquality"}
 *   POST /leave
 *   GET  /status
 */

#include "tmg_sdk.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <signal.h>
#include <sys/socket.h>
#include <netinet/in.h>
#include <unistd.h>
#include <pthread.h>
#include <dlfcn.h>
#include <execinfo.h>
#include <chrono>
#include <string>
#include "adapter-security.h"

static std::string g_gmeAppId;
static std::string g_gmeAppKey;
static int g_gmeAppIdNumber = 0;

static bool loadGmeCredentials() {
    const char* appId = getenv("GME_SDK_APP_ID");
    const char* appKey = getenv("GME_SDK_KEY");
    if (!appId || !*appId || !appKey || strlen(appKey) != 16) return false;
    for (const char* cursor = appId; *cursor; ++cursor) {
        if (*cursor < '0' || *cursor > '9') return false;
    }
    char* end = nullptr;
    const unsigned long value = strtoul(appId, &end, 10);
    if (!end || *end || value == 0 || value > 2147483647UL) return false;
    g_gmeAppId = appId;
    g_gmeAppKey = appKey;
    g_gmeAppIdNumber = static_cast<int>(value);
    return true;
}

// Runtime config (overridable via CLI args)
static int g_httpPort = 9876;
static char g_botId[128] = {0};

// Console verbosity: by default only real errors/failures print. GME fires
// event callbacks and HTTP requests constantly (every /status or /volume
// poll, every join/leave/audio event, every fade-in/out tick) — logging all
// of it drowns out anything actually worth seeing. Pass --verbose for the
// old fully-chatty behavior when actively debugging.
static bool g_verbose = false;
#define LOGI(...) do { if (g_verbose) { printf(__VA_ARGS__); fflush(stdout); } } while(0)
#define LOGE(...) do { printf(__VA_ARGS__); fflush(stdout); } while(0)

// ==================== RUNTIME SDK LOADING ====================
// Load GME SDK via dlopen to avoid crashes during static library loading.
// The Android .so files may have constructors that crash before main().

typedef ITMGContext* (*FnGetInstance)();
typedef ITMGContext* (*FnGetInstanceInner)(const char*);
typedef int (*FnGenAuthBuffer)(int, const char*, const char*, const char*, unsigned char*, int);

static FnGetInstance pfnGetInstance = nullptr;
static FnGetInstanceInner pfnGetInstanceInner = nullptr;
static FnGenAuthBuffer pfnGenAuthBuffer = nullptr;
static void* g_sdkHandle = nullptr;

// Wrapper that uses dlopen'd function pointer. The 2.9.x SDK only exports
// ITMGContextGetInstanceInner(version); ITMGContextGetInstance() is a header inline.
static ITMGContext* GetGMEContext() {
    if (pfnGetInstanceInner) return pfnGetInstanceInner(TMG_SDK_VERSION);
    if (pfnGetInstance) return pfnGetInstance();
    return nullptr;
}

bool loadGMESDK() {
    LOGI("[SDK] Loading GME SDK via dlopen...\n");

    // First load our stubs so they're available when libgmesdk.so resolves deps
    void* logHandle = dlopen("liblog.so", RTLD_NOW | RTLD_GLOBAL);
    if (!logHandle) LOGI("[SDK] Note: liblog.so: %s\n", dlerror());
    else LOGI("[SDK] liblog.so loaded\n");

    void* bionicHandle = dlopen("libbionic_compat.so", RTLD_NOW | RTLD_GLOBAL);
    if (!bionicHandle) LOGI("[SDK] Note: libbionic_compat.so: %s\n", dlerror());
    else LOGI("[SDK] libbionic_compat.so loaded\n");

    void* openslHandle = dlopen("libOpenSLES.so", RTLD_NOW | RTLD_GLOBAL);
    if (!openslHandle) LOGI("[SDK] Note: libOpenSLES.so: %s\n", dlerror());
    else LOGI("[SDK] libOpenSLES.so loaded\n");

    // Load codec libraries first (dependencies of libgmesdk.so)
    const char* codecLibs[] = {
        "libgmeogg.so", "libgmefdkaac.so", "libgmelamemp3.so",
        "libgmefaad2.so", "libgmesoundtouch.so", NULL
    };
    for (int i = 0; codecLibs[i]; i++) {
        void* h = dlopen(codecLibs[i], RTLD_NOW | RTLD_GLOBAL);
        if (!h) {
            LOGE("[SDK] WARNING: %s: %s\n", codecLibs[i], dlerror());
        } else {
            LOGI("[SDK] %s loaded\n", codecLibs[i]);
        }
    }

    // Now load the main SDK
    LOGI("[SDK] Loading libgmesdk.so...\n");
    g_sdkHandle = dlopen("libgmesdk.so", RTLD_NOW | RTLD_GLOBAL);
    if (!g_sdkHandle) {
        LOGE("[SDK] FATAL: Cannot load libgmesdk.so: %s\n", dlerror());
        return false;
    }
    LOGI("[SDK] libgmesdk.so loaded OK!\n");

    // Resolve ITMGContextGetInstance
    pfnGetInstanceInner = (FnGetInstanceInner)dlsym(g_sdkHandle, "ITMGContextGetInstanceInner");
    if (!pfnGetInstanceInner) pfnGetInstance = (FnGetInstance)dlsym(g_sdkHandle, "ITMGContextGetInstance");
    if (!pfnGetInstanceInner && !pfnGetInstance) {
        // Try C++ mangled name
        pfnGetInstance = (FnGetInstance)dlsym(g_sdkHandle, "_Z21ITMGContextGetInstancev");
    }
    if (!pfnGetInstanceInner && !pfnGetInstance) {
        LOGE("[SDK] FATAL: Cannot find ITMGContextGetInstance symbol\n");
        return false;
    }
    LOGI("[SDK] ITMGContextGetInstance: resolved\n");

    // Resolve GenAuthBuffer
    pfnGenAuthBuffer = (FnGenAuthBuffer)dlsym(g_sdkHandle, "QAVSDK_AuthBuffer_GenAuthBuffer");
    if (!pfnGenAuthBuffer) {
        pfnGenAuthBuffer = (FnGenAuthBuffer)dlsym(g_sdkHandle, "_Z32QAVSDK_AuthBuffer_GenAuthBufferiPKcS0_S0_Phi");
    }
    if (!pfnGenAuthBuffer) {
        LOGE("[SDK] WARNING: Cannot find QAVSDK_AuthBuffer_GenAuthBuffer (will fail on EnterRoom)\n");
    } else {
        LOGI("[SDK] QAVSDK_AuthBuffer_GenAuthBuffer: resolved\n");
    }

    // Test: call ITMGContextGetInstance
    LOGI("[SDK] Calling ITMGContextGetInstance()...\n");
    ITMGContext* ctx = GetGMEContext();
    LOGI("[SDK] ITMGContextGetInstance() returned: %p\n", (void*)ctx);

    if (!ctx) {
        LOGE("[SDK] FATAL: ITMGContextGetInstance returned NULL\n");
        return false;
    }

    LOGI("[SDK] GME SDK loaded and initialized successfully!\n");
    return true;
}

// ==================== GLOBAL STATE ====================
static volatile bool g_running = true;
static volatile bool g_sdkLoaded = false;
static volatile bool g_initialized = false;
static volatile bool g_inRoom = false;
static volatile bool g_playing = false;
static volatile bool g_userStopped = false;
static volatile bool g_audioEnabled = false;
static volatile bool g_songFinished = false;
static char g_currentFile[512] = {0};
static char g_roomId[256] = {0};
static char g_userId[256] = {0};
static char g_lastError[512] = {0};
static volatile int g_lastEventType = -1;
// GME room-wide audio profile: 1=fluency, 2=standard, 3=highquality.
// This is distinct from accompaniment volume, which only affects the bot.
static volatile int g_roomType = 0;

static const char* roomTypeName(int roomType) {
    switch (roomType) {
        case ITMG_ROOM_TYPE_FLUENCY: return "fluency";
        case ITMG_ROOM_TYPE_STANDARD: return "standard";
        case ITMG_ROOM_TYPE_HIGHQUALITY: return "highquality";
        default: return "unknown";
    }
}

static int parseRoomType(const char* value) {
    if (!value) return 0;
    if (strcmp(value, "fluency") == 0 || strcmp(value, "1") == 0) return ITMG_ROOM_TYPE_FLUENCY;
    if (strcmp(value, "standard") == 0 || strcmp(value, "2") == 0) return ITMG_ROOM_TYPE_STANDARD;
    if (strcmp(value, "highquality") == 0 || strcmp(value, "high-quality") == 0 || strcmp(value, "3") == 0) return ITMG_ROOM_TYPE_HIGHQUALITY;
    return 0;
}

// Use the highest-fidelity room profile whenever this client enters a room.
// The profile can still be changed later through POST /room-quality.
static const ITMG_ROOM_TYPE DEFAULT_ROOM_TYPE = ITMG_ROOM_TYPE_HIGHQUALITY;

// ==================== COMMAND QUEUE ====================
enum CmdType { CMD_NONE = 0, CMD_JOIN, CMD_LEAVE, CMD_PLAY, CMD_STOP, CMD_PAUSE, CMD_RESUME, CMD_VOLUME, CMD_ROOM_TYPE };

struct Command {
    volatile CmdType type;
    char room[256];
    char user[256];
    char uuid[256];
    char file[512];
    bool loop;
    int volume;
    int roomType;
    volatile bool pending;
    volatile bool done;
    volatile bool success;
    char resultMsg[1024];
};

static Command g_cmd = {};
static pthread_mutex_t g_cmdMutex = PTHREAD_MUTEX_INITIALIZER;

// ==================== GME DELEGATE ====================
class GMEDelegate : public ITMGDelegate {
public:
    void OnEvent(ITMG_MAIN_EVENT_TYPE eventType, const char* data) override {
        g_lastEventType = eventType;
        switch (eventType) {
            case ITMG_MAIN_EVENT_TYPE_ENTER_ROOM:
                LOGI("[GME] Entered room! data=%s\n", data ? data : "null");
                g_inRoom = true;
                g_lastError[0] = 0;
                enableAudioInternal();
                {
                    ITMGRoom* room = GetGMEContext()->GetRoom();
                    if (room) g_roomType = room->GetRoomType();
                }
                break;
            case ITMG_MAIN_EVENT_TYPE_EXIT_ROOM:
                LOGI("[GME] Exited room\n");
                g_inRoom = false;
                g_roomType = 0;
                g_audioEnabled = false;
                g_songFinished = false;
                g_roomId[0] = 0;
                break;
            case ITMG_MAIN_EVENT_TYPE_ROOM_DISCONNECT:
                LOGE("[GME] Room disconnected: %s\n", data ? data : "null");
                g_inRoom = false;
                g_roomType = 0;
                g_audioEnabled = false;
                g_songFinished = false;
                g_roomId[0] = 0;
                snprintf(g_lastError, sizeof(g_lastError), "Room disconnected: %s", data ? data : "unknown");
                break;
            case ITMG_MAIN_EVNET_TYPE_USER_UPDATE:
                break;
            case ITMG_MAIN_EVENT_TYPE_ACCOMPANY_FINISH:
                LOGI("[GME] Accompaniment finished (userStopped=%d)\n", (int)g_userStopped);
                g_playing = false;
                if (!g_userStopped) g_songFinished = true;
                g_userStopped = false;
                break;
            case ITMG_MAIN_EVENT_TYPE_CHANGE_ROOM_TYPE: {
                ITMGRoom* room = GetGMEContext() ? GetGMEContext()->GetRoom() : nullptr;
                if (room) g_roomType = room->GetRoomType();
                LOGE("[GME] Room quality changed by another participant: type=%d (%s) data=%s\n",
                     (int)g_roomType, roomTypeName(g_roomType), data ? data : "null");
                break;
            }
            case 1022: // ITMG_MAIN_EVENT_TYPE_CHANGE_ROOM_QUALITY — fires continuously
                       // (network delay/loss/weight stats), not actionable, drowns out
                       // everything else in the console. Silently ignored.
                break;
            default:
                LOGI("[GME] Event %d: %s\n", eventType, data ? data : "null");
                break;
        }
    }

    static void enableAudioInternal() {
        ITMGContext* context = GetGMEContext();
        if (!context) return;
        ITMGAudioCtrl* audioCtrl = context->GetAudioCtrl();
        if (audioCtrl) {
            audioCtrl->EnableAudioCaptureDevice(true);
            // The shared send path is needed for accompaniment; keep the
            // physical microphone mix muted in this music-only adapter.
            audioCtrl->EnableAudioSend(true);
            audioCtrl->SetMicVolume(0);
            audioCtrl->EnableSpeaker(true);

            ITMGAudioEffectCtrl* effectCtrl = context->GetAudioEffectCtrl();
            if (effectCtrl) {
                effectCtrl->SetAccompanyVolume(5);
            }

            g_audioEnabled = true;
            LOGI("[GME] Music audio path enabled (microphone muted)\n");
        }
    }
};

static GMEDelegate g_delegate;

// ==================== GME OPERATIONS (MAIN THREAD ONLY) ====================

bool initGME(const char* userId) {
    ITMGContext* context = GetGMEContext();
    if (!context) {
        snprintf(g_lastError, sizeof(g_lastError), "Failed to get GME context");
        return false;
    }

    if (g_initialized && strcmp(g_userId, userId) == 0) {
    LOGI("[GME] Already initialized for the configured identity, skipping\n");
        return true;
    }

    if (g_initialized || g_lastEventType >= 0) {
        LOGI("[GME] Uninitializing before re-init...\n");
        if (g_inRoom) {
            context->ExitRoom();
            for (int i = 0; i < 10; i++) { context->Poll(); usleep(100000); }
        }
        context->Uninit();
        g_initialized = false;
        g_inRoom = false;
        g_audioEnabled = false;
        g_roomType = 0;
        usleep(200000);
    }

    context->SetTMGDelegate(&g_delegate);
    context->SetLogLevel(TMG_LOG_LEVEL_INFO, TMG_LOG_LEVEL_INFO);

    LOGI("[GME] Init with configured SDK identity, UserID=%s...\n", userId);

    int ret = context->Init(g_gmeAppId.c_str(), userId);
    if (ret != 0) {
        LOGE("[GME] Init failed: %d (userId=%s)\n", ret, userId);
        snprintf(g_lastError, sizeof(g_lastError), "GME Init failed: %d (userId=%s)", ret, userId);
        context->Uninit();
        return false;
    }

    g_initialized = true;
    strncpy(g_userId, userId, sizeof(g_userId) - 1);
    g_lastError[0] = 0;
    LOGI("[GME] Initialized for the configured identity\n");
    return true;
}

bool enterRoom(const char* roomId, const char* authUserId) {
    ITMGContext* context = GetGMEContext();
    if (!context) return false;

    const char* authId = (authUserId && strlen(authUserId) > 0) ? authUserId : g_userId;

    unsigned char authBuffer[512] = {0};
    int authLen = 0;
    if (pfnGenAuthBuffer) {
        authLen = pfnGenAuthBuffer(
            g_gmeAppIdNumber, roomId, authId, g_gmeAppKey.c_str(), authBuffer, sizeof(authBuffer)
        );
    } else {
        snprintf(g_lastError, sizeof(g_lastError), "GenAuthBuffer not available (symbol not found)");
        LOGE("[GME] %s\n", g_lastError);
        return false;
    }

    if (authLen <= 0) {
        snprintf(g_lastError, sizeof(g_lastError), "GenAuthBuffer failed (authLen=%d)", authLen);
        LOGE("[GME] %s\n", g_lastError);
        return false;
    }

    LOGI("[GME] AuthBuffer generated: %d bytes\n", authLen);
    LOGI("[GME] EnterRoom requested: room=%s, type=HIGHQUALITY\n", roomId);

    int ret = context->EnterRoom(roomId, DEFAULT_ROOM_TYPE, (const char*)authBuffer, authLen);
    if (ret != 0) {
        snprintf(g_lastError, sizeof(g_lastError), "EnterRoom returned: %d", ret);
        LOGE("[GME] %s\n", g_lastError);
        return false;
    }

    strncpy(g_roomId, roomId, sizeof(g_roomId) - 1);
    g_roomType = DEFAULT_ROOM_TYPE;
    LOGI("[GME] EnterRoom accepted, waiting for callback...\n");
    return true;
}

bool playMusic(const char* filePath, bool loop) {
    g_songFinished = false;
    ITMGContext* context = GetGMEContext();
    if (!context || !g_inRoom) {
        snprintf(g_lastError, sizeof(g_lastError), "Not in room (inRoom=%d, init=%d)", (int)g_inRoom, (int)g_initialized);
        return false;
    }
    if (access(filePath, F_OK) != 0) {
        snprintf(g_lastError, sizeof(g_lastError), "File not found: %s", filePath);
        return false;
    }
    ITMGAudioEffectCtrl* effectCtrl = context->GetAudioEffectCtrl();
    if (!effectCtrl) {
        snprintf(g_lastError, sizeof(g_lastError), "GetAudioEffectCtrl returned null");
        return false;
    }
    int loopCount = loop ? -1 : 1;
    int ret = effectCtrl->StartAccompany(filePath, true, loopCount, 0);
    if (ret != 0) {
        snprintf(g_lastError, sizeof(g_lastError), "StartAccompany returned: %d", ret);
        return false;
    }
    strncpy(g_currentFile, filePath, sizeof(g_currentFile) - 1);
    g_playing = true;
    g_songFinished = false;
    g_userStopped = false;
    g_lastError[0] = 0;
    LOGI("[GME] Playing: %s (loop=%s)\n", filePath, loop ? "yes" : "no");
    return true;
}

void stopMusic() {
    g_songFinished = false;
    ITMGContext* context = GetGMEContext();
    if (!context) return;
    ITMGAudioEffectCtrl* effectCtrl = context->GetAudioEffectCtrl();
    if (effectCtrl) {
        g_userStopped = true;
        g_songFinished = false;
        effectCtrl->StopAccompany(0);
        g_playing = false;
        LOGI("[GME] Stopped\n");
    }
}

// ==================== MAIN THREAD: PROCESS COMMANDS ====================

void processCommand(Command* cmd) {
    ITMGContext* ctx = GetGMEContext();

    switch (cmd->type) {
        case CMD_JOIN: {
            g_songFinished = false;
            if (g_inRoom) {
                LOGI("[GME] Leaving current room first...\n");
                ctx->ExitRoom();
                for (int i = 0; i < 20 && g_inRoom; i++) { ctx->Poll(); usleep(100000); }
            }

            if (!initGME(cmd->user)) {
                cmd->success = false;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":false,\"error\":\"GME init failed\",\"lastError\":\"%s\"}", g_lastError);
                break;
            }

            const char* authId = strlen(cmd->uuid) > 0 ? cmd->uuid : cmd->user;
            if (!enterRoom(cmd->room, authId)) {
                cmd->success = false;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":false,\"error\":\"EnterRoom failed\",\"lastError\":\"%s\"}", g_lastError);
                break;
            }

            for (int i = 0; i < 100 && !g_inRoom; i++) {
                ctx->Poll();
                usleep(100000);
            }

            if (g_inRoom) {
                LOGI("[GME] Room entry confirmed (room=%s)\n", cmd->room);
                cmd->success = true;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":true,\"inRoom\":true,\"room\":\"%s\",\"audioEnabled\":%s}",
                    cmd->room, g_audioEnabled ? "true" : "false");
            } else {
                snprintf(g_lastError, sizeof(g_lastError), "Room entry timeout 10s");
                LOGE("[GME] %s\n", g_lastError);
                cmd->success = false;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":false,\"inRoom\":false,\"error\":\"Room entry timeout\",\"lastError\":\"%s\"}", g_lastError);
            }
            break;
        }

        case CMD_LEAVE: {
            if (g_playing) stopMusic();
            if (ctx && g_inRoom) ctx->ExitRoom();
            g_audioEnabled = false;
            g_songFinished = false;
            g_roomId[0] = 0;
            g_roomType = 0;
            cmd->success = true;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg), "{\"success\":true}");
            break;
        }

        case CMD_PLAY: {
            bool ok = playMusic(cmd->file, cmd->loop);
            cmd->success = ok;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                "{\"success\":%s,\"file\":\"%s\",\"inRoom\":%s,\"lastError\":\"%s\"}",
                ok ? "true" : "false", cmd->file, g_inRoom ? "true" : "false", g_lastError);
            break;
        }

        case CMD_STOP: {
            stopMusic();
            cmd->success = true;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg), "{\"success\":true}");
            break;
        }

        case CMD_PAUSE: {
            if (ctx && ctx->GetAudioEffectCtrl()) ctx->GetAudioEffectCtrl()->PauseAccompany();
            cmd->success = true;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg), "{\"success\":true}");
            break;
        }

        case CMD_RESUME: {
            if (ctx && ctx->GetAudioEffectCtrl()) ctx->GetAudioEffectCtrl()->ResumeAccompany();
            cmd->success = true;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg), "{\"success\":true}");
            break;
        }

        case CMD_VOLUME: {
            if (ctx && ctx->GetAudioEffectCtrl()) ctx->GetAudioEffectCtrl()->SetAccompanyVolume(cmd->volume);
            cmd->success = true;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg), "{\"success\":true,\"vol\":%d}", cmd->volume);
            break;
        }

        case CMD_ROOM_TYPE: {
            if (!ctx || !g_inRoom || !ctx->GetRoom()) {
                cmd->success = false;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":false,\"error\":\"Not in GME room\"}");
                break;
            }
            if (cmd->roomType != ITMG_ROOM_TYPE_FLUENCY &&
                cmd->roomType != ITMG_ROOM_TYPE_STANDARD &&
                cmd->roomType != ITMG_ROOM_TYPE_HIGHQUALITY) {
                cmd->success = false;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":false,\"error\":\"Invalid room quality\"}");
                break;
            }
            ITMGRoom* room = ctx->GetRoom();
            int ret = room->ChangeRoomType((ITMG_ROOM_TYPE)cmd->roomType);
            if (ret != 0) {
                cmd->success = false;
                snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                    "{\"success\":false,\"error\":\"ChangeRoomType failed\",\"code\":%d,\"roomType\":%d,\"roomQuality\":\"%s\"}",
                    ret, (int)g_roomType, roomTypeName(g_roomType));
                break;
            }
            int current = room->GetRoomType();
            g_roomType = current > 0 ? current : cmd->roomType;
            cmd->success = true;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg),
                "{\"success\":true,\"roomType\":%d,\"roomQuality\":\"%s\"}",
                (int)g_roomType, roomTypeName(g_roomType));
            LOGE("[GME] Room quality set to %s (type=%d)\n", roomTypeName(g_roomType), (int)g_roomType);
            break;
        }

        default:
            cmd->success = false;
            snprintf(cmd->resultMsg, sizeof(cmd->resultMsg), "{\"error\":\"unknown command\"}");
            break;
    }
}

// ==================== HTTP SERVER (BACKGROUND THREAD) ====================

bool submitCommandAndWait(CmdType type, int timeoutMs = 20000) {
    if (!g_sdkLoaded) {
        snprintf(g_cmd.resultMsg, sizeof(g_cmd.resultMsg),
            "{\"success\":false,\"error\":\"GME SDK not loaded\"}");
        return false;
    }
    g_cmd.type = type;
    g_cmd.done = false;
    g_cmd.success = false;
    g_cmd.resultMsg[0] = 0;
    g_cmd.pending = true;

    int waited = 0;
    while (!g_cmd.done && waited < timeoutMs) {
        usleep(50000);
        waited += 50;
    }

    if (!g_cmd.done) {
        snprintf(g_cmd.resultMsg, sizeof(g_cmd.resultMsg),
            "{\"success\":false,\"error\":\"Command timeout after %dms\"}", timeoutMs);
        g_cmd.pending = false;
        return false;
    }
    return g_cmd.success;
}

static std::string jsonEscape(const char* value) {
    std::string escaped;
    if (!value) return escaped;
    for (const unsigned char* p = (const unsigned char*)value; *p; ++p) {
        switch (*p) {
            case '\\': escaped += "\\\\"; break;
            case '"': escaped += "\\\""; break;
            case '\b': escaped += "\\b"; break;
            case '\f': escaped += "\\f"; break;
            case '\n': escaped += "\\n"; break;
            case '\r': escaped += "\\r"; break;
            case '\t': escaped += "\\t"; break;
            default:
                if (*p < 0x20) {
                    char control[7];
                    snprintf(control, sizeof(control), "\\u%04x", (unsigned int)*p);
                    escaped += control;
                } else {
                    escaped.push_back((char)*p);
                }
                break;
        }
    }
    return escaped;
}

void handleHTTPRequest(int clientFd) {
    char buffer[4096] = {0};
    ssize_t bytesRead = 0;
    while (bytesRead < (ssize_t)sizeof(buffer) - 1) {
        ssize_t more = read(clientFd, buffer + bytesRead, sizeof(buffer) - 1 - bytesRead);
        if (more <= 0) { close(clientFd); return; }
        bytesRead += more;
        buffer[bytesRead] = 0;

        char* headerEnd = strstr(buffer, "\r\n\r\n");
        if (!headerEnd) continue;
        int contentLength = 0;
        const char* lengthHeader = strstr(buffer, "Content-Length:");
        if (lengthHeader) contentLength = atoi(lengthHeader + 15);
        const size_t headerBytes = (size_t)((headerEnd + 4) - buffer);
        const size_t expectedBytes = headerBytes + (contentLength > 0 ? (size_t)contentLength : 0);
        if ((size_t)bytesRead >= expectedBytes) break;
    }
    buffer[bytesRead] = 0;

    if (!gmeAdapterRequestAuthorized(buffer)) {
        const bool configured = !gmeAdapterExpectedToken().empty();
        const char* status = configured ? "401 Unauthorized" : "503 Service Unavailable";
        const char* message = configured ? "Invalid GME adapter token" : "GME adapter authentication is not configured";
        char unauthorized[512];
        snprintf(unauthorized, sizeof(unauthorized),
            "HTTP/1.1 %s\r\nContent-Type: application/json\r\n"
            "WWW-Authenticate: GME-Adapter\r\nConnection: close\r\n\r\n"
            "{\"ok\":false,\"error\":\"%s\"}", status, message);
        write(clientFd, unauthorized, strlen(unauthorized));
        close(clientFd);
        return;
    }

    char method[16] = {0}, path[256] = {0};
    sscanf(buffer, "%15s %255s", method, path);
    LOGI("[HTTP] %s %s\n", method, path);

    const char* musicEndpoints[] = {"/status", "/health", "/capabilities", "/join", "/play", "/stop", "/pause", "/resume", "/volume", "/room-quality", "/leave"};
    bool supportedEndpoint = false;
    for (const char* endpoint : musicEndpoints) {
        if (strcmp(path, endpoint) == 0) { supportedEndpoint = true; break; }
    }
    if (!supportedEndpoint) {
        const char* response = "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n{\"error\":\"unknown music adapter endpoint\"}";
        write(clientFd, response, strlen(response));
        close(clientFd);
        return;
    }

    char* body = strstr(buffer, "\r\n\r\n");
    if (body) body += 4;

    char response[8192] = {0};

    auto extractStr = [](const char* body, const char* key, char* out, size_t outLen) {
        char searchKey[64];
        snprintf(searchKey, sizeof(searchKey), "\"%s\"", key);
        const char* ptr = strstr(body, searchKey);
        if (!ptr) return;
        ptr = strchr(ptr + strlen(searchKey), '"');
        if (!ptr) return;
        ptr++;
        const char* end = strchr(ptr, '"');
        if (!end) return;
        size_t len = end - ptr;
        if (len >= outLen) len = outLen - 1;
        strncpy(out, ptr, len);
        out[len] = 0;
    };

    const std::string escapedBotId = jsonEscape(g_botId);

    if (strcmp(path, "/capabilities") == 0) {
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
            "{\"botId\":\"%s\",\"adapter\":\"linux-native\",\"protocolVersion\":2,\"sdkVersion\":\"2.9.15\",\"authenticated\":true,"
            "\"features\":{\"status\":true,\"health\":true,\"playMusic\":true,\"effects\":false,\"roomQuality\":true},"
            "\"endpoints\":[\"/status\",\"/health\",\"/capabilities\",\"/join\",\"/play\",\"/stop\",\"/pause\",\"/resume\",\"/volume\",\"/room-quality\",\"/leave\"]}",
            escapedBotId.c_str());
    }
    else if (strcmp(path, "/health") == 0) {
        const long long nowMs = std::chrono::duration_cast<std::chrono::milliseconds>(
            std::chrono::system_clock::now().time_since_epoch()).count();
        const std::string escapedError = jsonEscape(g_lastError);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
            "{\"botId\":\"%s\",\"adapter\":\"linux-native\",\"state\":\"%s\",\"reachable\":true,"
            "\"initialized\":%s,\"inRoom\":%s,\"playing\":%s,\"audioEnabled\":%s,"
            "\"reconnecting\":false,\"lastError\":\"%s\",\"observedAtMs\":%lld}",
            escapedBotId.c_str(), g_inRoom ? "ready" : "idle", g_initialized ? "true" : "false",
            g_inRoom ? "true" : "false", g_playing ? "true" : "false",
            g_audioEnabled ? "true" : "false", escapedError.c_str(), nowMs);
    }
    else if (strcmp(path, "/status") == 0) {
        const std::string escapedRoom = jsonEscape(g_roomId);
        const std::string escapedFile = jsonEscape(g_currentFile);
        const std::string escapedError = jsonEscape(g_lastError);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
            "{\"sdkLoaded\":%s,\"initialized\":%s,\"inRoom\":%s,\"playing\":%s,"
            "\"songFinished\":%s,\"currentFile\":\"%s\",\"file\":\"%s\",\"room\":\"%s\","
            "\"roomType\":%d,\"roomQuality\":\"%s\",\"lastError\":\"%s\"}",
            g_sdkLoaded ? "true" : "false", g_initialized ? "true" : "false",
            g_inRoom ? "true" : "false", g_playing ? "true" : "false",
            g_songFinished ? "true" : "false", escapedFile.c_str(), escapedFile.c_str(),
            escapedRoom.c_str(), (int)g_roomType, roomTypeName(g_roomType), escapedError.c_str());
    }
    else if (strcmp(path, "/join") == 0 && body) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        extractStr(body, "room", g_cmd.room, sizeof(g_cmd.room));
        extractStr(body, "user", g_cmd.user, sizeof(g_cmd.user));
        extractStr(body, "uuid", g_cmd.uuid, sizeof(g_cmd.uuid));

        LOGI("[GME] /join: room=%s\n", g_cmd.room);

        if (strlen(g_cmd.room) > 0 && strlen(g_cmd.user) > 0) {
            submitCommandAndWait(CMD_JOIN, 20000);
            int status = g_cmd.success ? 200 : 500;
            snprintf(response, sizeof(response),
                "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
                status, status == 200 ? "OK" : "Internal Server Error", g_cmd.resultMsg);
        } else {
            snprintf(response, sizeof(response),
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
                "{\"error\":\"need room and user. Optional: uuid for auth.\"}");
        }
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/play") == 0 && body) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        extractStr(body, "file", g_cmd.file, sizeof(g_cmd.file));
        g_cmd.loop = (strstr(body, "\"loop\":false") == NULL);

        if (strlen(g_cmd.file) > 0) {
            submitCommandAndWait(CMD_PLAY, 5000);
            snprintf(response, sizeof(response),
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
                g_cmd.resultMsg);
        } else {
            snprintf(response, sizeof(response),
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
                "{\"error\":\"need file path\"}");
        }
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/stop") == 0) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        submitCommandAndWait(CMD_STOP, 5000);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
            g_cmd.resultMsg);
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/pause") == 0) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        submitCommandAndWait(CMD_PAUSE, 5000);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
            g_cmd.resultMsg);
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/resume") == 0) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        submitCommandAndWait(CMD_RESUME, 5000);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
            g_cmd.resultMsg);
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/volume") == 0 && body) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        g_cmd.volume = 100;
        char* volPtr = strstr(body, "\"vol\"");
        if (volPtr) sscanf(volPtr, "\"vol\":%d", &g_cmd.volume);
        submitCommandAndWait(CMD_VOLUME, 5000);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
            g_cmd.resultMsg);
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/room-quality") == 0 && body) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        char quality[32] = {0};
        extractStr(body, "quality", quality, sizeof(quality));
        g_cmd.roomType = parseRoomType(quality);
        if (!g_cmd.roomType) {
            snprintf(response, sizeof(response),
                "HTTP/1.1 400 Bad Request\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
                "{\"success\":false,\"error\":\"quality must be fluency, standard, or highquality\"}");
        } else {
            submitCommandAndWait(CMD_ROOM_TYPE, 5000);
            snprintf(response, sizeof(response),
                "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
                g_cmd.success ? 200 : 409, g_cmd.success ? "OK" : "Conflict", g_cmd.resultMsg);
        }
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else if (strcmp(path, "/leave") == 0) {
        pthread_mutex_lock(&g_cmdMutex);
        memset(&g_cmd, 0, sizeof(g_cmd));
        submitCommandAndWait(CMD_LEAVE, 5000);
        snprintf(response, sizeof(response),
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n%s",
            g_cmd.resultMsg);
        pthread_mutex_unlock(&g_cmdMutex);
    }
    else {
        snprintf(response, sizeof(response),
            "HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nAccess-Control-Allow-Origin: *\r\n\r\n"
            "{\"endpoints\":[\"/status\",\"/health\",\"/capabilities\",\"/join\",\"/play\",\"/stop\",\"/pause\",\"/resume\",\"/volume\",\"/room-quality\",\"/leave\"]}");
    }

    write(clientFd, response, strlen(response));
    close(clientFd);
}

void* httpServerThread(void* arg) {
    int serverFd = socket(AF_INET, SOCK_STREAM, 0);
    int opt = 1;
    setsockopt(serverFd, SOL_SOCKET, SO_REUSEADDR, &opt, sizeof(opt));

    struct sockaddr_in addr;
    addr.sin_family = AF_INET;
    addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    addr.sin_port = htons(g_httpPort);

    if (bind(serverFd, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
        LOGE("HTTP bind failed on port %d\n", g_httpPort);
        return NULL;
    }
    listen(serverFd, 5);
    printf("HTTP server listening on port %d\n", g_httpPort); fflush(stdout);

    while (g_running) {
        int clientFd = accept(serverFd, NULL, NULL);
        if (clientFd >= 0) handleHTTPRequest(clientFd);
    }
    close(serverFd);
    return NULL;
}

// ==================== CRASH HANDLER ====================

void crashHandler(int sig) {
    fprintf(stderr, "\n[CRASH] Signal %d (%s) received!\n", sig,
            sig == SIGSEGV ? "SIGSEGV" : sig == SIGABRT ? "SIGABRT" : "UNKNOWN");
    fprintf(stderr, "[CRASH] Backtrace:\n");
    void* frames[32];
    int n = backtrace(frames, 32);
    backtrace_symbols_fd(frames, n, 2);
    fprintf(stderr, "[CRASH] To debug: gdb -batch -ex run -ex bt --args ./gme-music-bot-linux --port 9876\n");
    fflush(stderr);
    _exit(1);
}

// ==================== SIGNAL HANDLER ====================

void signalHandler(int sig) {
    printf("\nShutting down...\n"); fflush(stdout);
    g_running = false;
    if (g_playing) stopMusic();
    ITMGContext* ctx = GetGMEContext();
    if (ctx && g_initialized) {
        if (g_inRoom) ctx->ExitRoom();
        ctx->Uninit();
    }
    exit(0);
}

// ==================== MAIN ====================

int main(int argc, char* argv[]) {
    if (!loadGmeCredentials()) {
        fprintf(stderr, "GME_SDK_APP_ID and a 16-byte GME_SDK_KEY are required in the local environment\n");
        return 2;
    }

    // Register crash handler FIRST — before any SDK loading
    signal(SIGSEGV, crashHandler);
    signal(SIGABRT, crashHandler);
    signal(SIGINT, signalHandler);
    signal(SIGTERM, signalHandler);

    // Parse only local adapter runtime options.
    for (int i = 1; i < argc; i++) {
        if (strcmp(argv[i], "--port") == 0 && i + 1 < argc) {
            g_httpPort = atoi(argv[++i]);
        } else if (strcmp(argv[i], "--bot-id") == 0 && i + 1 < argc) {
            strncpy(g_botId, argv[++i], sizeof(g_botId) - 1);
        } else if (strcmp(argv[i], "--verbose") == 0) {
            g_verbose = true;
        }
    }

    printf("GME Music Bot for YelloTalk (Linux) v2\n");
    printf("   GME credentials: external environment\n");
    printf("   HTTP Control: http://127.0.0.1:%d (token protected)\n", g_httpPort);
    if (g_botId[0]) printf("   Bot ID: %s\n", g_botId);
    printf("   SDK Loading: runtime dlopen (safe mode)\n\n");
    fflush(stdout);

    // Start HTTP server FIRST (so /status works even if SDK fails)
    pthread_t httpThread;
    pthread_create(&httpThread, NULL, httpServerThread, NULL);

    // Load GME SDK at runtime (not at binary load time)
    g_sdkLoaded = loadGMESDK();
    if (!g_sdkLoaded) {
        LOGE("\n[FATAL] GME SDK failed to load. HTTP server still running for diagnostics.\n");
        LOGE("        curl http://localhost:%d/status to check state.\n", g_httpPort);
        LOGE("        The bot will respond to commands but GME operations will fail.\n\n");
        // Don't exit — keep HTTP server running for diagnostics
    }

    if (!g_sdkLoaded) {
        printf("SDK not loaded — waiting for HTTP diagnostics...\n");
        fflush(stdout);
    } else {
        printf("Waiting for explicit HTTP room/music commands on port %d...\n", g_httpPort);
        fflush(stdout);
    }

    // ==================== MAIN LOOP ====================
    while (g_running) {
        // The Android-built SDK segfaults when polled before Init().
        if (g_sdkLoaded && g_initialized) {
            ITMGContext* ctx = GetGMEContext();
            if (ctx) ctx->Poll();
        }

        if (g_cmd.pending) {
            g_cmd.pending = false;
            LOGI("[Main] Processing command type=%d\n", g_cmd.type);
            processCommand(&g_cmd);
            g_cmd.done = true;
        }

        usleep(33000);
    }

    return 0;
}
