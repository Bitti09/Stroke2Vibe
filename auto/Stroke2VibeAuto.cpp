// Stroke2VibeAuto — convert a stroke (L0) funscript into a coherent dual-vibe (V0/V1) script.
//
// Standalone, dependency-free C++17. Reads a funscript (JSON or JSON5-ish: comments,
// trailing commas, single quotes, unquoted keys are tolerated), derives ONE intensity
// envelope E(t) from the stroke speed, and splits it energy-preservingly onto two
// vibration axes (w0 + w1 = 1). The result is embedded as an "axes" array:
//
//   { "version": "1.1",
//     "actions": [ {"at":...,"pos":...}, ... ],        <- L0, untouched
//     "axes": [ {"id":"V0","actions":[...]}, {"id":"V1","actions":[...]} ] }
//
// Single-file multi-axis format (SLR/MFP/EroScripts convention). Plain single-axis
// players ignore "axes" and keep working unchanged.
//
// Modes: auto/travel/alternate/layer/surge  (see README.md)

#include <algorithm>
#include <cctype>
#include <charconv>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <fstream>
#include <iostream>
#include <sstream>
#include <string>
#include <utility>
#include <vector>

// ============================== options ==============================

struct Options {
    std::string input;
    std::string out;            // empty => in-place (with .bak)
    bool        split = false;  // additionally write <base>.vib.funscript / .vib1.funscript
    std::string mode = "auto";  // auto|travel|alternate|layer|surge
    bool        travelFromTop = false;
    double      duty = 0.7;
    double      layerRatio = 0.5;
    double      depth = 0.35;
    double      echo = 120.0;       // ms, surge
    double      gamma = 0.65;
    double      gateP = 0.15;       // percentile gate
    double      target = 85.0;      // p99 -> target
    double      smoothMs = 80.0;
    double      gapSec = 3.0;       // silence inside gaps longer than this
    double      minGapMs = 40.0;    // rate cap per vibe axis
    double      floorVal = 12.0;
    double      dwellMs = 600.0;    // travel: freeze below this half-stroke duration
    double      maxSwitchHz = 1.5;  // alternate: max perceivable switch rate
    std::string axes = "V0,V1";
    bool        force = false;
    bool        stats = false;
    bool        dryRun = false;
};

// ============================== JSON DOM ==============================

struct JValue {
    enum class T { Null, Bool, Num, Str, Arr, Obj };
    T t = T::Null;
    bool b = false;
    double num = 0.0;
    bool isInt = false;
    std::string str;
    std::vector<JValue> arr;
    std::vector<std::pair<std::string, JValue>> obj;

    JValue* find(const std::string& key) {
        if (t != T::Obj) return nullptr;
        for (auto& kv : obj) if (kv.first == key) return &kv.second;
        return nullptr;
    }
    const JValue* find(const std::string& key) const {
        if (t != T::Obj) return nullptr;
        for (const auto& kv : obj) if (kv.first == key) return &kv.second;
        return nullptr;
    }
};

struct JParser {
    const std::string& s;
    size_t p = 0;
    std::string err;

    explicit JParser(const std::string& src) : s(src) {}

    void skipWs() {
        while (p < s.size()) {
            char c = s[p];
            if (c == ' ' || c == '\t' || c == '\r' || c == '\n') { ++p; continue; }
            if (c == '/' && p + 1 < s.size()) {
                if (s[p + 1] == '/') { p = s.find('\n', p); if (p == std::string::npos) p = s.size(); continue; }
                if (s[p + 1] == '*') { p = s.find("*/", p + 2); p = (p == std::string::npos) ? s.size() : p + 2; continue; }
            }
            break;
        }
    }

    bool parseValue(JValue& out, int depth) {
        if (depth > 64) { err = "nesting too deep"; return false; }
        skipWs();
        if (p >= s.size()) { err = "unexpected end of input"; return false; }
        char c = s[p];
        if (c == '{') return parseObj(out, depth);
        if (c == '[') return parseArr(out, depth);
        if (c == '"') { out.t = JValue::T::Str; return parseStr(out.str); }
        if (c == '\'') { out.t = JValue::T::Str; return parseStr(out.str, true); }
        if (c == 't' || c == 'T') { if (s.compare(p, 4, "true") == 0) { p += 4; out.t = JValue::T::Bool; out.b = true; return true; } }
        if (c == 'f' || c == 'F') { if (s.compare(p, 5, "false") == 0) { p += 5; out.t = JValue::T::Bool; out.b = false; return true; } }
        if (c == 'n' || c == 'N') { if (s.compare(p, 4, "null") == 0) { p += 4; out.t = JValue::T::Null; return true; } }
        if (c == '-' || c == '+' || c == '.' || std::isdigit((unsigned char)c)) return parseNum(out);
        err = "unexpected character '" + std::string(1, c) + "'";
        return false;
    }

    bool parseNum(JValue& out) {
        size_t start = p;
        if (p < s.size() && (s[p] == '-' || s[p] == '+')) ++p;
        bool isInt = true;
        if (p + 1 < s.size() && s[p] == '0' && (s[p + 1] == 'x' || s[p + 1] == 'X')) { // hex
            p += 2; size_t h = p;
            while (p < s.size() && std::isxdigit((unsigned char)s[p])) ++p;
            if (p == h) { err = "bad hex number"; return false; }
            out.t = JValue::T::Num; out.isInt = true;
            try { out.num = (double)std::stoll(s.substr(h, p - h), nullptr, 16); }
            catch (...) { err = "hex number out of range"; return false; }
            return true;
        }
        while (p < s.size() && std::isdigit((unsigned char)s[p])) ++p;
        if (p < s.size() && s[p] == '.') { isInt = false; ++p; while (p < s.size() && std::isdigit((unsigned char)s[p])) ++p; }
        if (p < s.size() && (s[p] == 'e' || s[p] == 'E')) { isInt = false; ++p; if (p < s.size() && (s[p] == '+' || s[p] == '-')) ++p; while (p < s.size() && std::isdigit((unsigned char)s[p])) ++p; }
        if (p == start) { err = "bad number"; return false; }
        std::string tok = s.substr(start, p - start);
        out.t = JValue::T::Num; out.isInt = isInt;
        try { out.num = std::stod(tok); }
        catch (...) { err = "number out of range"; return false; }
        return true;
    }

    bool parseStr(std::string& out, bool single = false) {
        char quote = single ? '\'' : '"';
        ++p; // opening quote
        while (p < s.size()) {
            char c = s[p];
            if (c == quote) { ++p; return true; }
            if (c == '\\' && p + 1 < s.size()) {
                char e = s[p + 1]; ++p; ++p;
                switch (e) {
                    case 'n': out += '\n'; break;
                    case 't': out += '\t'; break;
                    case 'r': out += '\r'; break;
                    case 'b': out += '\b'; break;
                    case 'f': out += '\f'; break;
                    case 'u': {
                        if (p + 4 > s.size()) { err = "bad \\u escape"; return false; }
                        unsigned cp = (unsigned)std::stoul(s.substr(p, 4), nullptr, 16);
                        p += 4;
                        // UTF-8 encode (BMP only; surrogate pairs tolerated as-is)
                        if (cp < 0x80) out += (char)cp;
                        else if (cp < 0x800) { out += (char)(0xC0 | (cp >> 6)); out += (char)(0x80 | (cp & 0x3F)); }
                        else { out += (char)(0xE0 | (cp >> 12)); out += (char)(0x80 | ((cp >> 6) & 0x3F)); out += (char)(0x80 | (cp & 0x3F)); }
                        break;
                    }
                    default: out += e; break;
                }
                continue;
            }
            out += c; ++p;
        }
        err = "unterminated string";
        return false;
    }

    bool parseIdent(std::string& out) {
        size_t start = p;
        while (p < s.size() && (std::isalnum((unsigned char)s[p]) || s[p] == '_' || s[p] == '$')) ++p;
        if (p == start) return false;
        out = s.substr(start, p - start);
        return true;
    }

    bool parseObj(JValue& out, int depth) {
        out = JValue{}; out.t = JValue::T::Obj;
        ++p; // {
        skipWs();
        if (p < s.size() && s[p] == '}') { ++p; return true; }
        while (true) {
            skipWs();
            std::string key;
            if (p < s.size() && (s[p] == '"' || s[p] == '\'')) {
                if (!parseStr(key, s[p] == '\'')) return false;
            } else if (!parseIdent(key)) {
                err = "expected object key"; return false;
            }
            skipWs();
            if (p >= s.size() || (s[p] != ':' && s[p] != '=')) { err = "expected ':' after key"; return false; }
            ++p;
            JValue val;
            if (!parseValue(val, depth + 1)) return false;
            out.obj.emplace_back(std::move(key), std::move(val));
            skipWs();
            if (p < s.size() && s[p] == ',') { ++p; skipWs(); if (p < s.size() && s[p] == '}') { ++p; return true; } continue; }
            if (p < s.size() && s[p] == '}') { ++p; return true; }
            err = "expected ',' or '}' in object"; return false;
        }
    }

    bool parseArr(JValue& out, int depth) {
        out = JValue{}; out.t = JValue::T::Arr;
        ++p; // [
        skipWs();
        if (p < s.size() && s[p] == ']') { ++p; return true; }
        while (true) {
            JValue val;
            if (!parseValue(val, depth + 1)) return false;
            out.arr.push_back(std::move(val));
            skipWs();
            if (p < s.size() && s[p] == ',') { ++p; skipWs(); if (p < s.size() && s[p] == ']') { ++p; return true; } continue; }
            if (p < s.size() && s[p] == ']') { ++p; return true; }
            err = "expected ',' or ']' in array"; return false;
        }
    }
};

// ============================== serializer ==============================

static std::string fmtDouble(double v) {
    if (std::isnan(v) || std::isinf(v)) return "null";
    char buf[64];
    auto res = std::to_chars(buf, buf + sizeof(buf), v);
    return std::string(buf, res.ptr);
}

static std::string escapeStr(const std::string& in) {
    std::string o;
    o += '"';
    for (unsigned char c : in) {
        switch (c) {
            case '"': o += "\\\""; break;
            case '\\': o += "\\\\"; break;
            case '\n': o += "\\n"; break;
            case '\t': o += "\\t"; break;
            case '\r': o += "\\r"; break;
            default:
                if (c < 0x20) { char b[8]; std::snprintf(b, sizeof(b), "\\u%04x", c); o += b; }
                else o += (char)c;
        }
    }
    o += '"';
    return o;
}

struct JWriter {
    std::ostringstream o;
    int indent = 0;

    void pad() { for (int i = 0; i < indent; ++i) o << "  "; }

    void colon() { o << ": "; }

    // "actions"-style arrays: one compact {"at":..,"pos":..} per line
    static bool isActionArray(const JValue& v) {
        if (v.t != JValue::T::Arr || v.arr.empty()) return false;
        for (const auto& e : v.arr)
            if (e.t != JValue::T::Obj) return false;
        for (const auto& e : v.arr) {
            bool hasAt = false, ok = true;
            for (const auto& kv : e.obj) if (kv.first == "at") hasAt = true;
            if (!hasAt) ok = false;
            if (!ok) return false;
        }
        return true;
    }

        void writeActionsInline(const JValue& v) {
        for (size_t i = 0; i < v.arr.size(); ++i) {
            if (i) o << ", ";
            writeActionEntry(v.arr[i]);
        }
    }

    void writeActionEntry(const JValue& e) {
        o << "{\"at\":" << (long long)llround(e.obj[0].second.num);
        for (const auto& kv : e.obj)
            if (kv.first != "at") o << ",\"" << kv.first << "\":" << fmtDouble(kv.second.num);
        o << "}";
    }

    void writeActions(const JValue& v, const JValue* parent = nullptr) {
        // "[..." directly after the colon keeps {"actions": [ aligned with the input style
        o << (parent ? "[" : "[\n");
        if (parent) {
            for (size_t i = 0; i < v.arr.size(); ++i) {
                if (i) o << ", ";
                writeActionEntry(v.arr[i]);
            }
            o << "]";
            return;
        }
        ++indent;
        for (size_t i = 0; i < v.arr.size(); ++i) {
            pad();
            o << "{\"at\":" << (long long)llround(v.arr[i].obj[0].second.num);
            for (const auto& kv : v.arr[i].obj)
                if (kv.first != "at") o << ",\"" << kv.first << "\":" << fmtDouble(kv.second.num);
            o << (i + 1 < v.arr.size() ? "},\n" : "}\n");
        }
        --indent;
        pad(); o << "]";
    }

    void write(const JValue& v, bool inActionsKey = false) {
        switch (v.t) {
            case JValue::T::Null: o << "null"; break;
            case JValue::T::Bool: o << (v.b ? "true" : "false"); break;
            case JValue::T::Num:  o << fmtDouble(v.num); break;
            case JValue::T::Str:  o << escapeStr(v.str); break;
            case JValue::T::Arr: {
                if (isActionArray(v) && !inActionsKey) { writeActions(v); break; }
                if (v.arr.empty()) { o << "[]"; break; }
                bool simple = true;
                for (const auto& e : v.arr) if (e.t == JValue::T::Obj || e.t == JValue::T::Arr) simple = false;
                if (simple) {
                    o << "[";
                    for (size_t i = 0; i < v.arr.size(); ++i) { if (i) o << ", "; write(v.arr[i]); }
                    o << "]";
                } else {
                    o << "[\n"; ++indent;
                    for (size_t i = 0; i < v.arr.size(); ++i) { pad(); write(v.arr[i]); o << (i + 1 < v.arr.size() ? ",\n" : "\n"); }
                    --indent; pad(); o << "]";
                }
                break;
            }
            case JValue::T::Obj: {
                if (v.obj.empty()) { o << "{}"; break; }
                o << "{\n"; ++indent;
                for (size_t i = 0; i < v.obj.size(); ++i) {
                    pad(); o << escapeStr(v.obj[i].first) << ": ";
                    if (v.obj[i].first == "actions" && v.obj[i].second.t == JValue::T::Arr) { o << '['; writeActionsInline(v.obj[i].second); o << ']'; }
                    else write(v.obj[i].second);
                    o << (i + 1 < v.obj.size() ? ",\n" : "\n");
                }
                --indent; pad(); o << "}";
                break;
            }
        }
    }
};

// ============================== funscript model ==============================

struct Action { long long at = 0; double pos = 0; };

struct Script {
    JValue doc;
    std::vector<Action> l0;                 // top-level actions, sorted by at, unique
    std::string version = "1.0";
    bool hasAxesKey = false;
};

static bool readActions(const JValue& arr, std::vector<Action>& out) {
    for (const auto& e : arr.arr) {
        if (e.t != JValue::T::Obj) return false;
        const JValue* at = e.find("at");
        const JValue* pos = e.find("pos");
        if (!at || !pos || at->t != JValue::T::Num || pos->t != JValue::T::Num) return false;
        out.push_back({ (long long)llround(at->num), pos->num });
    }
    return true;
}

static bool loadScript(const std::string& text, Script& sc, std::string& err) {
    JParser jp(text);
    if (!jp.parseValue(sc.doc, 0)) {
        err = "JSON parse error at byte " + std::to_string(jp.p) + ": " + jp.err;
        return false;
    }
    if (sc.doc.t != JValue::T::Obj) { err = "root is not a JSON object"; return false; }
    if (const JValue* v = sc.doc.find("version")) if (v->t == JValue::T::Str) sc.version = v->str;
    if (const JValue* a = sc.doc.find("actions")) {
        if (a->t == JValue::T::Arr && !readActions(*a, sc.l0)) { err = "\"actions\" has malformed entries"; return false; }
    }
    sc.hasAxesKey = sc.doc.find("axes") != nullptr;

    std::stable_sort(sc.l0.begin(), sc.l0.end(), [](const Action& x, const Action& y) { return x.at < y.at; });
    std::vector<Action> dedup;
    dedup.reserve(sc.l0.size());
    for (const auto& a : sc.l0) {
        if (!dedup.empty() && dedup.back().at == a.at) dedup.back().pos = a.pos; // last wins (map semantics)
        else dedup.push_back(a);
    }
    sc.l0 = std::move(dedup);
    return true;
}

// ============================== pipeline ==============================

struct EnvPoint { double t; double e; };

struct Envelope {
    std::vector<EnvPoint> pts;              // at segment midpoints
    std::vector<std::pair<double, double>> gaps; // silent intervals (exclusive)
    double scale = 1.0, gate = 0.0;
};

struct Tempo {
    std::vector<double> revs;               // reversal times (incl. script start/end)
    double T = 0;                           // median half-stroke interval (ms)
    double fStroke = 0;                     // strokes per second
};

static double sampleE(const Envelope& env, double t) {
    if (env.pts.empty()) return 0;
    for (const auto& g : env.gaps) if (t > g.first && t < g.second) return 0;
    if (t <= env.pts.front().t || t >= env.pts.back().t) return 0;
    size_t lo = 0, hi = env.pts.size() - 1;
    while (hi - lo > 1) {
        size_t mid = (lo + hi) / 2;
        if (env.pts[mid].t <= t) lo = mid; else hi = mid;
    }
    const EnvPoint& a = env.pts[lo];
    const EnvPoint& b = env.pts[hi];
    double f = (t - a.t) / ((b.t - a.t) != 0 ? (b.t - a.t) : 1);
    return a.e + f * (b.e - a.e);
}

static double percentile(std::vector<double> v, double p) { // by value, index floor(p*(n-1))
    if (v.empty()) return 0;
    std::sort(v.begin(), v.end());
    size_t idx = (size_t)std::floor(p * (double)(v.size() - 1));
    return v[idx];
}

static Envelope buildEnvelope(const std::vector<Action>& l0, const Options& o) {
    Envelope env;
    if (l0.size() < 2) return env;

    std::vector<EnvPoint> mids;
    mids.reserve(l0.size());
    for (size_t i = 1; i < l0.size(); ++i) {
        double dt = (double)(l0[i].at - l0[i - 1].at);
        double dp = std::fabs(l0[i].pos - l0[i - 1].pos);
        mids.push_back({ ((double)l0[i].at + (double)l0[i - 1].at) / 2.0, dt > 0 ? dp / dt : 0.0 });
    }
    // p99 -> target
    std::vector<double> vs;
    vs.reserve(mids.size());
    for (auto& m : mids) vs.push_back(m.e);
    double p99 = percentile(vs, 0.99);
    env.scale = p99 > 0 ? o.target / p99 : 1.0;
    for (auto& m : mids) m.e = std::min(100.0, m.e * env.scale);
    // gate
    std::vector<double> es;
    es.reserve(mids.size());
    for (auto& m : mids) es.push_back(m.e);
    env.gate = percentile(es, o.gateP);
    for (auto& m : mids) if (m.e < env.gate) m.e = 0;
    // smoothing: moving average over +-smooth/2 (no-op for sparse scripts)
    if (o.smoothMs > 0) {
        std::vector<EnvPoint> sm;
        sm.reserve(mids.size());
        size_t n = mids.size();
        size_t j = 0;
        for (size_t i = 0; i < n; ++i) {
            double lo = mids[i].t - o.smoothMs / 2, hi = mids[i].t + o.smoothMs / 2;
            while (j < n && mids[j].t < lo) ++j;
            size_t k = j;
            double sum = 0; size_t cnt = 0;
            while (k < n && mids[k].t <= hi) { sum += mids[k].e; ++cnt; ++k; }
            sm.push_back({ mids[i].t, cnt ? sum / (double)cnt : mids[i].e });
        }
        mids = std::move(sm);
    }
    // gamma
    for (auto& m : mids) m.e = 100.0 * std::pow(m.e / 100.0, o.gamma);
    env.pts = std::move(mids);

    // gaps -> silence
    double gapMs = o.gapSec * 1000.0;
    for (size_t i = 1; i < l0.size(); ++i) {
        double d = (double)(l0[i].at - l0[i - 1].at);
        if (d > gapMs) env.gaps.emplace_back((double)l0[i - 1].at, (double)l0[i].at);
    }
    return env;
}

static Tempo buildTempo(const std::vector<Action>& l0) {
    Tempo tp;
    if (l0.size() < 3) { tp.revs = { (double)l0[0].at, (double)l0.back().at }; return tp; }
    tp.revs.push_back((double)l0.front().at);
    for (size_t i = 1; i + 1 < l0.size(); ++i) {
        double d1 = l0[i].pos - l0[i - 1].pos;
        double d2 = l0[i + 1].pos - l0[i].pos;
        if (d1 * d2 < 0) tp.revs.push_back((double)l0[i].at);
    }
    tp.revs.push_back((double)l0.back().at);
    std::vector<double> ints;
    for (size_t i = 1; i + 1 < tp.revs.size(); ++i) ints.push_back(tp.revs[i] - tp.revs[i - 1]);
    if (!ints.empty()) {
        std::sort(ints.begin(), ints.end());
        tp.T = ints[ints.size() / 2];
        tp.fStroke = 1000.0 / (2.0 * tp.T);
    }
    return tp;
}

static size_t segOf(const std::vector<double>& revs, double t) {
    size_t k = 0;
    while (k + 2 < revs.size() && t > revs[k + 1]) ++k;
    return k;
}

struct Weights { double w0, w1; };

struct ModeCtx {
    const Options* o;
    const Envelope* env;
    const Tempo* tp;
    double fMod; // layer modulation frequency (Hz)
};

static Weights wTravel(const ModeCtx& c, double t) {
    size_t k = segOf(c.tp->revs, t);
    double d = c.tp->revs[k + 1] - c.tp->revs[k];
    if (d < c.o->dwellMs) return { 0.5, 0.5 };                     // too fast to localize -> balance
    double p = (t - c.tp->revs[k]) / d;
    if ((k % 2 == 1) != c.o->travelFromTop) p = 1 - p;             // alternate sweep direction
    double cc = std::max(0.0, std::min(1.0, p));
    double w1 = cc * cc / (((1 - cc) * (1 - cc)) + cc * cc);
    return { 1 - w1, w1 };
}

static Weights wAlternate(const ModeCtx& c, double t) {
    size_t k = segOf(c.tp->revs, t);
    double d = c.tp->revs[k + 1] - c.tp->revs[k];
    if (d <= 0) return { 0.5, 0.5 };
    int beat = 1;
    if (1000.0 / d > c.o->maxSwitchHz) {
        if (500.0 / d > c.o->maxSwitchHz) return { 0.5, 0.5 };     // too fast -> balance
        beat = 2;
    }
    bool v0Active = (long long)(k / beat) % 2 == 0;
    return v0Active ? Weights{ c.o->duty, 1 - c.o->duty } : Weights{ 1 - c.o->duty, c.o->duty };
}

static Weights wLayer(const ModeCtx& c, double t) {
    double w0 = 0.5 + c.o->depth * std::sin(2.0 * 3.14159265358979323846 * c.fMod * t / 1000.0);
    w0 = std::max(0.0, std::min(1.0, w0));
    return { w0, 1 - w0 };
}

static Weights wSurge(const ModeCtx&, double) { return { 1.0, 1.0 }; }

// motor pass: dead-zone + floor, returns unrounded value
static double appl(double v, double floorVal) {
    if (v < floorVal / 2) return 0;
    if (v < floorVal) return floorVal;
    return v;
}

struct AxisOut { std::vector<Action> actions; };

struct Stats {
    long long n0 = 0, n1 = 0;
    double act0 = 0, act1 = 0, mean0 = 0, mean1 = 0, p990 = 0, p991 = 0, max0 = 0, max1 = 0;
    double swpm = 0, corr = 0, degr = 0, sat = 0, switchHz = 0;
};

static Stats runMode(const Options& o, const Script& sc, const Envelope& env, const Tempo& tp,
                     const std::string& mode, std::vector<Action>& outV0, std::vector<Action>& outV1) {
    ModeCtx ctx{ &o, &env, &tp, 0.0 };
    ctx.fMod = o.layerRatio * tp.fStroke;

    struct Row { double t, e, v0, v1, w0, w1; };
    std::vector<Row> rows;
    rows.reserve(sc.l0.size());
    for (const auto& a : sc.l0) {
        double t = (double)a.at;
        double e = sampleE(env, t);
        Weights w = mode == "travel" || mode == "auto" ? wTravel(ctx, t)
                  : mode == "alternate" ? wAlternate(ctx, t)
                  : mode == "layer" ? wLayer(ctx, t)
                  : wSurge(ctx, t);
        double v1 = mode == "surge" ? appl(sampleE(env, t - o.echo), o.floorVal) : appl(e * w.w1, o.floorVal);
        rows.push_back({ t, e, appl(e * w.w0, o.floorVal), v1, w.w0, w.w1 });
    }

    // rate cap per axis
    auto cap = [&](const std::vector<Row>& rows, bool axis0) {
        std::vector<Action> out;
        double lastT = -1e18;
        for (size_t i = 0; i < rows.size(); ++i) {
            const Row& r = rows[i];
            bool isLast = i + 1 == rows.size();
            if (!isLast && lastT > -1e17 && r.t - lastT < o.minGapMs) continue;
            double v = axis0 ? r.v0 : r.v1;
            out.push_back({ (long long)llround(r.t), std::round(v) });
            lastT = r.t;
        }
        return out;
    };
    outV0 = cap(rows, true);
    outV1 = cap(rows, false);

    // stats
    Stats st;
    st.n0 = (long long)outV0.size();
    st.n1 = (long long)outV1.size();
    std::vector<double> a0, a1;
    double sum0 = 0, sum1 = 0;
    for (const auto& r : rows) {
        if (r.v0 > 0) { a0.push_back(r.v0); sum0 += r.v0; }
        if (r.v1 > 0) { a1.push_back(r.v1); sum1 += r.v1; }
    }
    st.act0 = rows.empty() ? 0 : 100.0 * a0.size() / rows.size();
    st.act1 = rows.empty() ? 0 : 100.0 * a1.size() / rows.size();
    st.mean0 = a0.empty() ? 0 : sum0 / a0.size();
    st.mean1 = a1.empty() ? 0 : sum1 / a1.size();
    auto p99of = [](std::vector<double> v) { std::sort(v.begin(), v.end()); return v.empty() ? 0.0 : v[(size_t)(0.99 * (v.size() - 1))]; };
    st.p990 = p99of(a0); st.p991 = p99of(a1);
    st.max0 = a0.empty() ? 0 : *std::max_element(a0.begin(), a0.end());
    st.max1 = a1.empty() ? 0 : *std::max_element(a1.begin(), a1.end());
    // switches/min
    double span = tp.revs.empty() ? 0 : tp.revs.back() - tp.revs.front();
    double sw = 0;
    if (rows.size() > 1) {
        int prev = 0;
        for (const auto& r : rows) {
            int s = r.w0 > r.w1 ? 1 : (r.w0 < r.w1 ? -1 : 0);
            if (prev != 0 && s != 0 && s != prev) ++sw;
            if (s != 0) prev = s;
        }
    }
    st.swpm = span > 0 ? sw / (span / 60000.0) : 0;
    st.switchHz = span > 0 ? sw / (span / 1000.0) : 0;
    // degraded (travel/alternate balance share)
    if (mode == "travel" || mode == "auto" || mode == "alternate") {
        double deg = 0;
        for (size_t k = 0; k + 1 < tp.revs.size(); ++k)
            if (tp.revs[k + 1] - tp.revs[k] < o.dwellMs) deg += tp.revs[k + 1] - tp.revs[k];
        st.degr = span > 0 ? 100.0 * deg / span : 0;
    }
    // saturation (surge)
    if (mode == "surge") {
        double sat = 0;
        for (const auto& r : rows) if (r.e + sampleE(env, r.t - o.echo) > 100) ++sat;
        st.sat = rows.empty() ? 0 : 100.0 * sat / rows.size();
    }
    // sync correlation blend vs 2E
    {
        std::vector<double> xs, ys;
        for (const auto& r : rows) if (r.e > 5) { xs.push_back(r.v0 + r.v1); ys.push_back(2 * r.e); }
        if (xs.size() > 1) {
            double mx = 0, my = 0;
            for (size_t i = 0; i < xs.size(); ++i) { mx += xs[i]; my += ys[i]; }
            mx /= xs.size(); my /= ys.size();
            double num = 0, dx = 0, dy = 0;
            for (size_t i = 0; i < xs.size(); ++i) {
                num += (xs[i] - mx) * (ys[i] - my);
                dx += (xs[i] - mx) * (xs[i] - mx);
                dy += (ys[i] - my) * (ys[i] - my);
            }
            st.corr = (dx > 0 && dy > 0) ? num / std::sqrt(dx * dy) : 0;
        }
    }
    return st;
}

// ============================== output ==============================

static JValue actionsToJ(const std::vector<Action>& acts) {
    JValue arr; arr.t = JValue::T::Arr;
    for (const auto& a : acts) {
        JValue o; o.t = JValue::T::Obj;
        JValue at; at.t = JValue::T::Num; at.isInt = true; at.num = (double)a.at;
        JValue pos; pos.t = JValue::T::Num; pos.isInt = true; pos.num = (double)std::lround(a.pos);
        o.obj.emplace_back("at", at);
        o.obj.emplace_back("pos", pos);
        arr.arr.push_back(std::move(o));
    }
    return arr;
}

static std::string serializeScript(const JValue& doc) {
    JWriter w;
    w.write(doc);
    w.o << "\n";
    return w.o.str();
}

// find or create the "axes" array in doc, then set/merge our two axes
static bool injectAxes(Script& sc, const std::string& id0, const std::vector<Action>& a0,
                       const std::string& id1, const std::vector<Action>& a1,
                       bool force, std::string& err) {
    JValue* axes = sc.doc.find("axes");
    if (!axes) {
        JValue arr; arr.t = JValue::T::Arr;
        JValue ax0; ax0.t = JValue::T::Obj;
        JValue idv; idv.t = JValue::T::Str; idv.str = id0;
        ax0.obj.emplace_back("id", idv);
        ax0.obj.emplace_back("actions", actionsToJ(a0));
        JValue ax1; ax1.t = JValue::T::Obj;
        idv.t = JValue::T::Str; idv.str = id1;
        ax1.obj.emplace_back("id", idv);
        ax1.obj.emplace_back("actions", actionsToJ(a1));
        arr.arr.push_back(std::move(ax0));
        arr.arr.push_back(std::move(ax1));
        sc.doc.obj.emplace_back("axes", std::move(arr));
        return true;
    }
    if (axes->t != JValue::T::Arr) { err = "\"axes\" exists but is not an array"; return false; }
    auto setAxis = [&](const std::string& id, const std::vector<Action>& acts) -> bool {
        for (auto& ax : axes->arr) {
            if (ax.t != JValue::T::Obj) continue;
            const JValue* idv = ax.find("id");
            if (idv && idv->t == JValue::T::Str) {
                std::string lo = idv->str, want = id;
                std::transform(lo.begin(), lo.end(), lo.begin(), ::tolower);
                std::transform(want.begin(), want.end(), want.begin(), ::tolower);
                if (lo == want) {
                    if (!force) {
                        err = "axis \"" + idv->str + "\" already exists (use --force to replace)";
                        return false;
                    }
                    // replace actions of this axis, keep other fields
                    JValue* old = ax.find("actions");
                    if (old) *old = actionsToJ(acts);
                    else ax.obj.emplace_back("actions", actionsToJ(acts));
                    return true;
                }
            }
        }
        JValue ax; ax.t = JValue::T::Obj;
        JValue idv; idv.t = JValue::T::Str; idv.str = id;
        ax.obj.emplace_back("id", idv);
        ax.obj.emplace_back("actions", actionsToJ(acts));
        axes->arr.push_back(std::move(ax));
        return true;
    };
    if (!setAxis(id0, a0)) return false;
    if (!setAxis(id1, a1)) return false;
    return true;
}

static std::string splitSuffix(const std::string& id) {
    std::string lo = id;
    std::transform(lo.begin(), lo.end(), lo.begin(), ::tolower);
    if (lo == "v0") return "vib";
    if (lo == "v1") return "vib1";
    return lo;
}

static bool writeText(const std::string& path, const std::string& content, std::string& err) {
    std::ofstream f(path, std::ios::binary | std::ios::trunc);
    if (!f) { err = "cannot write " + path; return false; }
    f << content;
    f.close();
    if (!f) { err = "write failed for " + path; return false; }
    return true;
}

static bool copyFile(const std::string& from, const std::string& to) {
    std::ifstream in(from, std::ios::binary);
    if (!in) return false;
    std::ostringstream ss; ss << in.rdbuf();
    std::ofstream out(to, std::ios::binary | std::ios::trunc);
    if (!out) return false;
    out << ss.str();
    return (bool)out;
}

static std::string baseName(const std::string& path) {
    std::string b = path;
    size_t slash = b.find_last_of("/\\");
    if (slash != std::string::npos) b = b.substr(slash + 1);
    size_t dot = b.find_last_of('.');
    if (dot != std::string::npos && dot > 0) b = b.substr(0, dot);
    return b;
}

static std::string dirName(const std::string& path) {
    size_t slash = path.find_last_of("/\\");
    if (slash == std::string::npos) return ".";
    return path.substr(0, slash);
}

static void printUsage() {
    std::cout <<
        "Stroke2VibeAuto - derive a coherent dual-vibe (V0/V1) script from a stroke (L0) funscript\n\n"
        "Usage: Stroke2VibeAuto <script.funscript> [options]\n\n"
        "Modes (--mode):\n"
        "  auto        travel with automatic fallback (default)\n"
        "  travel      wave travels base<->tip with the real stroke\n"
        "  alternate   tempo-locked ping-pong (duty 70/30)\n"
        "  layer       slow counter-phase breathing of both motors\n"
        "  surge       both motors full, V1 delayed by --echo ms\n\n"
        "Options:\n"
        "  --out <file>        write result to file instead of in-place (.bak backup)\n"
        "  --split             additionally write <base>.vib.funscript / .vib1.funscript\n"
        "  --axes V0,V1        axis ids to embed (default V0,V1)\n"
        "  --travel-from top|bottom  wave direction (default bottom)\n"
        "  --duty 0.7          alternate active-motor share\n"
        "  --layer-ratio 0.5   layer modulation as fraction of stroke frequency\n"
        "  --depth 0.35        layer modulation depth\n"
        "  --echo 120          surge delay (ms)\n"
        "  --gamma 0.65        intensity curve lift (1.0 = linear)\n"
        "  --gate 15           noise gate percentile\n"
        "  --target 85         p99 of speed maps to this intensity\n"
        "  --smooth 80         envelope smoothing window (ms)\n"
        "  --gap 3.0           script gaps longer than this (s) become silence\n"
        "  --min-gap 40        min ms between actions per vibe axis\n"
        "  --floor 12          motor minimum: below half = off, below = floor\n"
        "  --dwell 600         travel: freeze below this half-stroke duration (ms)\n"
        "  --max-switch 1.5    alternate: max switch rate (Hz)\n"
        "  --force             replace existing V0/V1 axes\n"
        "  --stats             print analysis report\n"
        "  --dry-run           analyze and report only, write nothing\n"
        "  -h | --help         show this help\n";
}

// ============================== main ==============================

int main(int argc, const char* argv[]) {
    Options o;
    std::vector<std::string> args(argv + 1, argv + argc);

    auto needValue = [&](size_t& i, const char* flag) -> std::string {
        if (i + 1 >= args.size()) { std::cout << "missing value for " << flag << "\n"; exit(EXIT_FAILURE); }
        return args[++i];
    };

    for (size_t i = 0; i < args.size(); ++i) {
        const std::string& a = args[i];
        if (a == "-h" || a == "--help") { printUsage(); return 0; }
        else if (a == "--out") o.out = needValue(i, "--out");
        else if (a == "--split") o.split = true;
        else if (a == "--mode") o.mode = needValue(i, "--mode");
        else if (a == "--axes") o.axes = needValue(i, "--axes");
        else if (a == "--travel-from") o.travelFromTop = needValue(i, "--travel-from") == "top";
        else if (a == "--duty") o.duty = std::stod(needValue(i, "--duty"));
        else if (a == "--layer-ratio") o.layerRatio = std::stod(needValue(i, "--layer-ratio"));
        else if (a == "--depth") o.depth = std::stod(needValue(i, "--depth"));
        else if (a == "--echo") o.echo = std::stod(needValue(i, "--echo"));
        else if (a == "--gamma") o.gamma = std::stod(needValue(i, "--gamma"));
        else if (a == "--gate") o.gateP = std::stod(needValue(i, "--gate")) / 100.0;
        else if (a == "--target") o.target = std::stod(needValue(i, "--target"));
        else if (a == "--smooth") o.smoothMs = std::stod(needValue(i, "--smooth"));
        else if (a == "--gap") o.gapSec = std::stod(needValue(i, "--gap"));
        else if (a == "--min-gap") o.minGapMs = std::stod(needValue(i, "--min-gap"));
        else if (a == "--floor") o.floorVal = std::stod(needValue(i, "--floor"));
        else if (a == "--dwell") o.dwellMs = std::stod(needValue(i, "--dwell"));
        else if (a == "--max-switch") o.maxSwitchHz = std::stod(needValue(i, "--max-switch"));
        else if (a == "--force") o.force = true;
        else if (a == "--stats") o.stats = true;
        else if (a == "--dry-run") o.dryRun = true;
        else if (!a.empty() && a[0] == '-') { std::cout << "unknown option: " << a << "\n"; printUsage(); return EXIT_FAILURE; }
        else o.input = a;
    }

    if (o.input.empty()) { printUsage(); return EXIT_FAILURE; }
    if (o.mode != "auto" && o.mode != "travel" && o.mode != "alternate" && o.mode != "layer" && o.mode != "surge") {
        std::cout << "unknown mode: " << o.mode << " (auto|travel|alternate|layer|surge)\n";
        return EXIT_FAILURE;
    }

    // read
    std::ifstream in(o.input, std::ios::binary);
    if (!in) { std::cout << "Cannot open file: " << o.input << "\n"; return EXIT_FAILURE; }
    std::ostringstream ss; ss << in.rdbuf();
    std::string text = ss.str();

    Script sc;
    std::string err;
    if (!loadScript(text, sc, err)) { std::cout << err << "\n"; return EXIT_FAILURE; }
    if (sc.l0.empty()) { std::cout << "No actions found in script.\n"; return EXIT_FAILURE; }

    // axes ids
    std::string id0 = "V0", id1 = "V1";
    {
        size_t comma = o.axes.find(',');
        if (comma != std::string::npos) {
            id0 = o.axes.substr(0, comma);
            id1 = o.axes.substr(comma + 1);
        } else if (!o.axes.empty()) {
            id0 = o.axes; id1 = "V1";
        }
    }

    // pipeline
    Envelope env = buildEnvelope(sc.l0, o);
    Tempo tp = buildTempo(sc.l0);
    std::vector<Action> v0, v1;
    Stats st = runMode(o, sc, env, tp, o.mode, v0, v1);

    if (o.stats) {
        double span = sc.l0.back().at - sc.l0.front().at;
        std::cout << "--- analysis ---\n";
        std::cout << "L0 actions: " << sc.l0.size() << " | active span: " << span / 1000.0 << " s\n";
        std::cout << "tempo: half-stroke median " << tp.T << " ms -> " << tp.fStroke << " strokes/s\n";
        std::cout << "envelope: scale x" << env.scale << " | gate " << env.gate << " | gamma " << o.gamma << "\n";
        std::cout << "--- mode: " << o.mode << " ---\n";
        std::cout << id0 << ": " << st.n0 << " actions | active " << st.act0 << "% | mean(active) " << st.mean0
                  << " | p99 " << st.p990 << " | max " << st.max0 << "\n";
        std::cout << id1 << ": " << st.n1 << " actions | active " << st.act1 << "% | mean(active) " << st.mean1
                  << " | p99 " << st.p991 << " | max " << st.max1 << "\n";
        std::cout << "switch rate: " << st.switchHz << " Hz (" << st.swpm << "/min) | degraded: " << st.degr << "%";
        if (o.mode == "surge") std::cout << " | saturation: " << st.sat << "%";
        std::cout << " | sync corr: " << st.corr << "\n";
        std::cout << "warnings:\n";
        bool warn = false;
        if (st.act0 < 10 || st.act1 < 10) { std::cout << "  - an axis is mostly silent (<10% active)\n"; warn = true; }
        if (st.act0 > 95 || st.act1 > 95) { std::cout << "  - an axis is nearly always on (>95% active)\n"; warn = true; }
        if (tp.fStroke > 0 && tp.fStroke < 0.3) { std::cout << "  - very slow detected tempo (<0.3 Hz)\n"; warn = true; }
        if (st.degr > 50) { std::cout << "  - script is fast: spatial patterns degrade to balance for " << st.degr << "% of the time\n"; warn = true; }
        if (!warn) std::cout << "  none\n";
    }

    if (o.dryRun) return 0;

    // inject axes
    if (!injectAxes(sc, id0, v0, id1, v1, o.force, err)) { std::cout << err << "\n"; return EXIT_FAILURE; }

    // serialize & write
    std::string result = serializeScript(sc.doc);
    std::string outPath = o.out.empty() ? o.input : o.out;
    if (o.out.empty()) {
        std::string bak = o.input + ".bak";
        if (!copyFile(o.input, bak)) std::cout << "Warning: could not create backup " << bak << "\n";
        else std::cout << "Backup: " << bak << "\n";
    }
    if (!writeText(outPath, result, err)) { std::cout << err << "\n"; return EXIT_FAILURE; }
    std::cout << "Wrote " << outPath << " (" << id0 << ": " << st.n0 << " actions, " << id1 << ": " << st.n1 << " actions)\n";

    if (o.split) {
        // companion files sit next to the input script (their expected discovery location)
        std::string dir = dirName(o.input);
        std::string base = baseName(o.input);
        std::string p0 = dir + "/" + base + "." + splitSuffix(id0) + ".funscript";
        std::string p1 = dir + "/" + base + "." + splitSuffix(id1) + ".funscript";
        JValue single0; single0.t = JValue::T::Obj;
        JValue ver0; ver0.t = JValue::T::Str; ver0.str = sc.version;
        single0.obj.emplace_back("version", ver0);
        single0.obj.emplace_back("actions", actionsToJ(v0));
        JValue single1; single1.t = JValue::T::Obj;
        JValue ver1; ver1.t = JValue::T::Str; ver1.str = sc.version;
        single1.obj.emplace_back("version", ver1);
        single1.obj.emplace_back("actions", actionsToJ(v1));
        if (!writeText(p0, serializeScript(single0), err)) { std::cout << err << "\n"; return EXIT_FAILURE; }
        if (!writeText(p1, serializeScript(single1), err)) { std::cout << err << "\n"; return EXIT_FAILURE; }
        std::cout << "Wrote " << p0 << " and " << p1 << "\n";
    }
    return 0;
}
