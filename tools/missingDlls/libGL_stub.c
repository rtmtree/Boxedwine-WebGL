// Minimal libGL.so.1 stub for boxedwine-wasm guest.
//
// Boxedwine implements GLX/GL via `int 0x99` traps from guest code; the
// real per-call dispatch lives in source/opengl/glcommon.cpp. This stub
// libGL.so.1 only exists so that Wine's wgl:init_opengl can dlopen the
// file and dlsym a few symbols without exploding. Mesa's real libGL
// would need a working GLX X server which we don't have.
//
// Strategy: every function returns a "success" / non-NULL placeholder.
// glGetString returns a fixed version string. Functions Wine asks for
// pointer to (via glXGetProcAddressARB) get this stub's own address.
//
// Build (i386 Linux .so):
//   docker run --rm --platform linux/386 -v $PWD:/work -w /work \
//     i386/debian:11-slim bash -c \
//     "apt-get -qq update && apt-get -y install gcc && \
//      gcc -m32 -shared -fPIC -o libGL.so.1 libGL_stub.c -nostdlib"
//
// The output is a ~5 KB ELF that provides ~50 commonly-checked exports.

#include <stddef.h>

typedef int Bool;
typedef unsigned int GLenum;
typedef unsigned int GLuint;
typedef unsigned int GLbitfield;
typedef int GLint;
typedef int GLsizei;
typedef float GLfloat;
typedef double GLdouble;
typedef unsigned char GLubyte;

// glGetString tokens
#define GL_VENDOR     0x1F00
#define GL_RENDERER   0x1F01
#define GL_VERSION    0x1F02
#define GL_EXTENSIONS 0x1F03

static const GLubyte _stub_vendor[]    = "boxedwine";
static const GLubyte _stub_renderer[]  = "boxedwine WebGL bridge";
static const GLubyte _stub_version[]   = "2.1 boxedwine-stub";
static const GLubyte _stub_extensions[] = "";
static const GLubyte _stub_empty[]     = "";

const GLubyte* glGetString(GLenum name) {
    switch (name) {
        case GL_VENDOR:     return _stub_vendor;
        case GL_RENDERER:   return _stub_renderer;
        case GL_VERSION:    return _stub_version;
        case GL_EXTENSIONS: return _stub_extensions;
        default:            return _stub_empty;
    }
}

GLenum glGetError(void) { return 0; }

// glXGetProcAddressARB — Wine asks for function pointers by name. We just
// return our own glGetString as a non-NULL placeholder so the lookup
// doesn't fail and Wine init can proceed. Real GL calls won't reach the
// stub — Boxedwine's int 0x99 dispatch handles them inside opengl32.dll.so.
typedef void (*_stub_proc)(void);
_stub_proc glXGetProcAddressARB(const GLubyte* name) {
    (void)name;
    return (_stub_proc)glGetString;
}
_stub_proc glXGetProcAddress(const GLubyte* name) {
    return glXGetProcAddressARB(name);
}

// GLX visual / context — return non-NULL fakes. Wine treats these as
// opaque handles; the actual context is created via int 0x99 paths in
// boxedwine, not through these calls.
static int _stub_visual = 0xCAFE0001;
static int _stub_context = 0xCAFE0002;
static int _stub_fbconfig = 0xCAFE0003;

void* glXChooseVisual(void* dpy, int screen, int* attribList) {
    (void)dpy; (void)screen; (void)attribList;
    return &_stub_visual;
}
void* glXCreateContext(void* dpy, void* vis, void* shareList, Bool direct) {
    (void)dpy; (void)vis; (void)shareList; (void)direct;
    return &_stub_context;
}
Bool glXMakeCurrent(void* dpy, unsigned long drawable, void* ctx) {
    (void)dpy; (void)drawable; (void)ctx;
    return 1;
}
void glXSwapBuffers(void* dpy, unsigned long drawable) {
    (void)dpy; (void)drawable;
}
void glXDestroyContext(void* dpy, void* ctx) { (void)dpy; (void)ctx; }
Bool glXIsDirect(void* dpy, void* ctx) { (void)dpy; (void)ctx; return 1; }
void* glXGetCurrentContext(void) { return &_stub_context; }
unsigned long glXGetCurrentDrawable(void) { return 0; }
Bool glXQueryExtension(void* dpy, int* error_base, int* event_base) {
    (void)dpy; if (error_base) *error_base = 0; if (event_base) *event_base = 0;
    return 1;
}
Bool glXQueryVersion(void* dpy, int* major, int* minor) {
    (void)dpy; if (major) *major = 1; if (minor) *minor = 4;
    return 1;
}
const char* glXQueryExtensionsString(void* dpy, int screen) {
    (void)dpy; (void)screen;
    return "GLX_ARB_create_context GLX_ARB_create_context_profile";
}
const char* glXQueryServerString(void* dpy, int screen, int name) {
    (void)dpy; (void)screen; (void)name;
    return "1.4";
}
const char* glXGetClientString(void* dpy, int name) {
    (void)dpy; (void)name;
    return "1.4";
}

void* glXChooseFBConfig(void* dpy, int screen, const int* attrib_list, int* nelements) {
    (void)dpy; (void)screen; (void)attrib_list;
    if (nelements) *nelements = 1;
    static void* fb = &_stub_fbconfig;
    return &fb;
}
void* glXGetVisualFromFBConfig(void* dpy, void* config) {
    (void)dpy; (void)config;
    return &_stub_visual;
}
int glXGetFBConfigAttrib(void* dpy, void* config, int attribute, int* value) {
    (void)dpy; (void)config; (void)attribute;
    if (value) *value = 0;
    return 0;
}
void* glXCreateContextAttribsARB(void* dpy, void* config, void* share, Bool direct, const int* attrib_list) {
    (void)dpy; (void)config; (void)share; (void)direct; (void)attrib_list;
    return &_stub_context;
}
void glXSwapIntervalEXT(void* dpy, unsigned long drawable, int interval) {
    (void)dpy; (void)drawable; (void)interval;
}
int glXSwapIntervalSGI(int interval) { (void)interval; return 0; }
int glXGetSwapIntervalMESA(void) { return 0; }
int glXSwapIntervalMESA(unsigned int interval) { (void)interval; return 0; }
int glXGetVideoSyncSGI(unsigned int* count) { if (count) *count = 0; return 0; }
int glXWaitVideoSyncSGI(int divisor, int remainder, unsigned int* count) {
    (void)divisor; (void)remainder; if (count) *count = 0; return 0;
}

// A very small selection of common gl* entry points so dlsym during Wine
// init succeeds. All are no-ops; real calls go through int 0x99.
void glClear(GLbitfield mask) { (void)mask; }
void glClearColor(GLfloat r, GLfloat g, GLfloat b, GLfloat a) {
    (void)r; (void)g; (void)b; (void)a;
}
void glViewport(GLint x, GLint y, GLsizei w, GLsizei h) {
    (void)x; (void)y; (void)w; (void)h;
}
void glFlush(void) {}
void glFinish(void) {}
void glEnable(GLenum cap) { (void)cap; }
void glDisable(GLenum cap) { (void)cap; }
typedef unsigned char GLboolean;
GLboolean glIsEnabled(GLenum cap) { (void)cap; return 0; }
void glDrawArrays(GLenum mode, GLint first, GLsizei count) { (void)mode; (void)first; (void)count; }
void glDrawElements(GLenum mode, GLsizei count, GLenum type, const void* indices) {
    (void)mode; (void)count; (void)type; (void)indices;
}
