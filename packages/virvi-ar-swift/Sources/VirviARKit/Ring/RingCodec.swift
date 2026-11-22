import CryptoKit
import Foundation

/// A decoded marker. `corrected` counts errors corrected plus erased symbols repaired.
public struct RingDecoded: Equatable {
    public let id: UInt32
    public let version: Int
    public let corrected: Int

    public init(id: UInt32, version: Int, corrected: Int) {
        self.id = id
        self.version = version
        self.corrected = corrected
    }
}

/// Registered test markers: `id` is an unsigned 32-bit value, `diameterM` is in metres.
public let RING_TEST_MARKERS: [(name: String, id: UInt32, diameterM: Double)] = [
    ("RING120", 0x1D2C_3B4A, 0.120),
    ("RING140", 0x2E3D_4C5B, 0.140),
    ("RING170", 0x3F4E_5D6C, 0.170),
]

/// Ring marker codec: systematic RS(12,6) over GF(64) laid out on 3 staggered rings. A port of
/// apps/quest/.../ring/RingCodec.kt (itself a port of apps/ring-marker/ringmarker/codec.py);
/// apps/ring-marker/vectors/codec.json is the contract.
///
/// Cell index = ring * 24 + cell; true means "on" (dark, raised).
public enum RingCodec {
    public static let cells = 72
    private static let perRing = 24
    private static let n = 12
    private static let k = 6
    private static let nsym = 6
    private static let maxErrors = 2
    /// 2 * errors + erasures may spend at most 4 of the 6 check symbols, so a wrong id needs at
    /// least 3 symbol errors beyond what is corrected (the rest of the code spots damage).
    private static let budget = 4
    private static let offset = [0, 2, 4]
    private static let crockford = Array("0123456789ABCDEFGHJKMNPQRSTVWXYZ")

    // --- GF(64), x^6 + x + 1 ---
    private static let tables: (exp: [Int], log: [Int]) = {
        var exp = [Int](repeating: 0, count: 126)
        var log = [Int](repeating: 0, count: 64)
        var x = 1
        for i in 0..<63 {
            exp[i] = x
            log[x] = i
            x <<= 1
            if x & 64 != 0 { x ^= 0x43 }
        }
        for i in 63..<126 { exp[i] = exp[i - 63] }
        return (exp, log)
    }()

    private static func gmul(_ a: Int, _ b: Int) -> Int {
        (a == 0 || b == 0) ? 0 : tables.exp[tables.log[a] + tables.log[b]]
    }

    private static func ginv(_ a: Int) -> Int { tables.exp[63 - tables.log[a]] }

    private static func pmul(_ p: [Int], _ q: [Int]) -> [Int] {
        var out = [Int](repeating: 0, count: p.count + q.count - 1)
        for i in p.indices { for j in q.indices { out[i + j] ^= gmul(p[i], q[j]) } }
        return out
    }

    /// Evaluates a polynomial (low degree first) at `x`.
    private static func peval(_ p: [Int], _ x: Int) -> Int {
        var acc = 0
        for i in p.indices.reversed() { acc = gmul(acc, x) ^ p[i] }
        return acc
    }

    /// Generator with roots alpha^0 .. alpha^5 (low degree first, monic).
    private static let gen: [Int] = (0..<nsym).reduce([1]) { g, j in pmul(g, [tables.exp[j], 1]) }

    // --- layout and mask ---
    private static let mask: [Bool] = {
        let d = Array(SHA256.hash(data: Data("VLM ring marker v0".utf8))) // virvi-rename: keep (the printed rings depend on this seed)
        return (0..<cells).map { i in (d[i / 8] >> UInt8(7 - i % 8)) & 1 == 1 }
    }()

    private static let symbolCells: [[Int]] = (0..<n).map { j in
        let ring = j / 4
        let start = ((j % 4) * 6 + offset[ring]) % perRing
        return (0..<6).map { b in ring * perRing + (start + b) % perRing }
    }

    /// Systematic codeword: data symbols followed by 6 parity symbols.
    private static func rsEncode(_ data: [Int]) -> [Int] {
        var rem = [Int](repeating: 0, count: nsym) // rem[0] is the highest-degree coefficient
        for d in data {
            let fb = d ^ rem[0]
            for i in 0..<(nsym - 1) { rem[i] = rem[i + 1] }
            rem[nsym - 1] = 0
            if fb != 0 { for i in 0..<nsym { rem[i] ^= gmul(fb, gen[nsym - 1 - i]) } }
        }
        return data + rem
    }

    /// Encodes a 32-bit `id` and 4-bit `version` into 72 masked cells.
    public static func encode(id: UInt32, version: Int = 0) -> [Bool] {
        precondition(version >= 0 && version < 16, "version must be 4-bit")
        let value = (UInt64(version) << 32) | UInt64(id)
        let data = (0..<k).map { i in Int((value >> UInt64(30 - 6 * i)) & 63) }
        let symbols = rsEncode(data)
        var raw = [Bool](repeating: false, count: cells)
        for j in symbols.indices {
            for b in 0..<6 { raw[symbolCells[j][b]] = (symbols[j] >> (5 - b)) & 1 == 1 }
        }
        return (0..<cells).map { raw[$0] != mask[$0] }
    }

    // --- decoding ---
    private static func berlekampMassey(_ s: [Int]) -> [Int] {
        var c = [1]
        var b = [1]
        var l = 0
        var m = 1
        var bb = 1
        for n in s.indices {
            var d = s[n]
            if l >= 1 { for i in 1...l where i < c.count { d ^= gmul(c[i], s[n - i]) } }
            if d == 0 {
                m += 1
                continue
            }
            let t = c
            let coef = gmul(d, ginv(bb))
            let shifted = [Int](repeating: 0, count: m) + b.map { gmul(coef, $0) }
            while c.count < shifted.count { c.append(0) }
            for i in shifted.indices { c[i] ^= shifted[i] }
            if 2 * l <= n {
                l = n + 1 - l
                b = t
                bb = d
                m = 1
            } else {
                m += 1
            }
        }
        var out = [Int](repeating: 0, count: l + 1)
        for i in 0...l where i < c.count { out[i] = c[i] }
        return out
    }

    /// Decodes 72 cells in transmitted order; nil entries are erasures. Returns nil unless the
    /// word is a codeword within the correction budget (errors <= 2 and 2 * errors + erasures <= 4).
    public static func decode(_ input: [Bool?]) -> RingDecoded? {
        precondition(input.count == cells, "expected 72 cells")
        let raw: [Bool?] = (0..<cells).map { i in input[i].map { $0 != mask[i] } }
        var recv = [Int](repeating: 0, count: n)
        var erased: [Int] = []
        for j in 0..<n {
            var v = 0
            var gone = false
            for c in symbolCells[j] {
                guard let bit = raw[c] else {
                    gone = true
                    break
                }
                v = (v << 1) | (bit ? 1 : 0)
            }
            if gone { erased.append(j) } else { recv[j] = v }
        }
        let e = erased.count
        if e > nsym { return nil }
        let exp = tables.exp
        let loc = (0..<n).map { j in exp[(n - 1 - j) % 63] } // X_j = alpha^(11-j)
        let syn: [Int] = (0..<nsym).map { t in
            var acc = 0
            for j in 0..<n { acc ^= gmul(recv[j], exp[(t * (n - 1 - j)) % 63]) }
            return acc
        }

        var gamma = [1]
        for j in erased { gamma = pmul(gamma, [1, loc[j]]) }
        let product = pmul(syn, gamma)
        let modp = (0..<nsym).map { $0 < product.count ? product[$0] : 0 }
        let sigma = berlekampMassey(Array(modp[e..<nsym]))
        var nerr = sigma.count - 1
        while nerr > 0 && sigma[nerr] == 0 { nerr -= 1 }
        if sigma.count - 1 != nerr { return nil } // degree-deficient locator
        if nerr > maxErrors { return nil }
        if 2 * nerr + e > budget { return nil }
        let lam = pmul(gamma, Array(sigma[0...nerr]))
        let p = pmul(syn, lam)
        let omega = (0..<nsym).map { $0 < p.count ? p[$0] : 0 }
        var dlam = [Int](repeating: 0, count: lam.count - 1)
        for kk in dlam.indices where (kk + 1) % 2 == 1 { dlam[kk] = lam[kk + 1] }

        var fixed = recv
        var roots = 0
        for j in 0..<n {
            let xinv = ginv(loc[j])
            if peval(lam, xinv) != 0 { continue }
            roots += 1
            let den = peval(dlam, xinv)
            if den == 0 { return nil }
            fixed[j] ^= gmul(loc[j], gmul(peval(omega, xinv), ginv(den)))
        }
        if roots != lam.count - 1 { return nil }

        // Safety net: expected unreachable once the degree and root-count checks pass.
        if rsEncode(Array(fixed[0..<k])) != fixed { return nil }
        var value: UInt64 = 0
        for j in 0..<k { value = (value << 6) | UInt64(fixed[j]) }
        let nbad = (0..<n).filter { !erased.contains($0) && fixed[$0] != recv[$0] }.count
        return RingDecoded(id: UInt32(value & 0xFFFF_FFFF), version: Int(value >> 32), corrected: nbad + e)
    }

    /// The 32-bit `id` as 7 Crockford base32 characters.
    public static func codeOf(_ id: UInt32) -> String {
        String((0..<7).map { i in crockford[Int((id >> UInt32(30 - 5 * i)) & 31)] })
    }

    /// Reads a typed or linked code, the way the server's `parseRingCode` does: case-insensitive,
    /// I/L as 1, O as 0, hyphens and spaces ignored, exactly 7 characters whose value is below 2^32.
    public static func parseCode(_ code: String) -> UInt32? {
        var clean: [Character] = []
        for ch in code.uppercased() {
            if ch == "-" || ch.isWhitespace { continue }
            switch ch {
            case "I", "L": clean.append("1")
            case "O": clean.append("0")
            default: clean.append(ch)
            }
        }
        if clean.count != 7 { return nil }
        var value: UInt64 = 0
        for ch in clean {
            guard let d = crockford.firstIndex(of: ch) else { return nil }
            value = value * 32 + UInt64(d)
        }
        return value < (1 << 32) ? UInt32(value) : nil
    }
}
