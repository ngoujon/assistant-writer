// Génère assets/icon-1024.png : squircle encre violette + feuille écrite + étincelle IA.
// Usage : swift scripts/make-icon.swift <chemin de sortie>

import AppKit
import CoreGraphics
import Foundation

let size: CGFloat = 1024
let out = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "assets/icon-1024.png"

guard let ctx = CGContext(
  data: nil,
  width: Int(size),
  height: Int(size),
  bitsPerComponent: 8,
  bytesPerRow: 0,
  space: CGColorSpace(name: CGColorSpace.sRGB)!,
  bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue
) else {
  fatalError("contexte graphique indisponible")
}

ctx.setAllowsAntialiasing(true)
ctx.interpolationQuality = .high

// --- Squircle : marge façon icône macOS (le glyphe occupe ~80 % du canevas)
let inset: CGFloat = size * 0.098
let rect = CGRect(x: inset, y: inset, width: size - inset * 2, height: size - inset * 2)
let radius = rect.width * 0.2237
let squircle = CGPath(roundedRect: rect, cornerWidth: radius, cornerHeight: radius, transform: nil)

ctx.saveGState()
ctx.addPath(squircle)
ctx.clip()
// Encre violette : lumière en haut à gauche, profondeur en bas à droite.
let colors = [
  CGColor(red: 0.671, green: 0.541, blue: 0.965, alpha: 1),
  CGColor(red: 0.416, green: 0.322, blue: 0.878, alpha: 1),
  CGColor(red: 0.161, green: 0.106, blue: 0.435, alpha: 1),
] as CFArray
let gradient = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                          colors: colors, locations: [0, 0.48, 1])!
ctx.drawLinearGradient(gradient,
                       start: CGPoint(x: rect.minX, y: rect.maxY),
                       end: CGPoint(x: rect.maxX, y: rect.minY),
                       options: [])

let glow = CGGradient(colorsSpace: CGColorSpace(name: CGColorSpace.sRGB)!,
                      colors: [CGColor(red: 1, green: 1, blue: 1, alpha: 0.14),
                               CGColor(red: 1, green: 1, blue: 1, alpha: 0)] as CFArray,
                      locations: [0, 1])!
ctx.drawRadialGradient(glow,
                       startCenter: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.maxY - rect.height * 0.18),
                       startRadius: 0,
                       endCenter: CGPoint(x: rect.minX + rect.width * 0.28, y: rect.maxY - rect.height * 0.18),
                       endRadius: rect.width * 0.72,
                       options: [])
ctx.restoreGState()

// --- La feuille : coin replié en haut à droite, quelques lignes de texte.
let cx = size / 2 - size * 0.018
let cy = size / 2 - size * 0.010
let w = size * 0.360
let h = size * 0.460
let pli = size * 0.108
let trait = size * 0.058

let feuille = CGMutablePath()
let gauche = cx - w / 2
let droite = cx + w / 2
let bas = cy - h / 2
let haut = cy + h / 2
let arrondi = size * 0.036

feuille.move(to: CGPoint(x: gauche, y: haut - arrondi))
feuille.addArc(tangent1End: CGPoint(x: gauche, y: haut), tangent2End: CGPoint(x: gauche + arrondi, y: haut), radius: arrondi)
feuille.addLine(to: CGPoint(x: droite - pli, y: haut))
feuille.addLine(to: CGPoint(x: droite, y: haut - pli))
feuille.addLine(to: CGPoint(x: droite, y: bas + arrondi))
feuille.addArc(tangent1End: CGPoint(x: droite, y: bas), tangent2End: CGPoint(x: droite - arrondi, y: bas), radius: arrondi)
feuille.addLine(to: CGPoint(x: gauche + arrondi, y: bas))
feuille.addArc(tangent1End: CGPoint(x: gauche, y: bas), tangent2End: CGPoint(x: gauche, y: bas + arrondi), radius: arrondi)
feuille.closeSubpath()

ctx.saveGState()
ctx.setShadow(offset: CGSize(width: 0, height: -size * 0.012), blur: size * 0.036,
              color: CGColor(red: 0.08, green: 0.05, blue: 0.28, alpha: 0.30))
ctx.setStrokeColor(CGColor(red: 1, green: 1, blue: 1, alpha: 1))
ctx.setLineWidth(trait)
ctx.setLineCap(.round)
ctx.setLineJoin(.round)
ctx.addPath(feuille)
ctx.strokePath()

// Le repli du coin.
ctx.move(to: CGPoint(x: droite - pli, y: haut))
ctx.addLine(to: CGPoint(x: droite - pli, y: haut - pli))
ctx.addLine(to: CGPoint(x: droite, y: haut - pli))
ctx.strokePath()

// Les lignes écrites : deux pleines, une plus courte.
ctx.setLineWidth(trait * 0.86)
for (i, largeur) in [0.62, 0.62, 0.36].enumerated() {
  let y = cy + h * 0.085 - CGFloat(i) * (h * 0.175)
  ctx.move(to: CGPoint(x: gauche + w * 0.19, y: y))
  ctx.addLine(to: CGPoint(x: gauche + w * (0.19 + largeur), y: y))
}
ctx.strokePath()
ctx.restoreGState()

// --- Étincelle (le côté « assistant »)
func sparkle(at center: CGPoint, radius r: CGFloat, alpha: CGFloat) {
  let waist = r * 0.30
  let path = CGMutablePath()
  path.move(to: CGPoint(x: center.x, y: center.y + r))
  path.addQuadCurve(to: CGPoint(x: center.x + r, y: center.y),
                    control: CGPoint(x: center.x + waist, y: center.y + waist))
  path.addQuadCurve(to: CGPoint(x: center.x, y: center.y - r),
                    control: CGPoint(x: center.x + waist, y: center.y - waist))
  path.addQuadCurve(to: CGPoint(x: center.x - r, y: center.y),
                    control: CGPoint(x: center.x - waist, y: center.y - waist))
  path.addQuadCurve(to: CGPoint(x: center.x, y: center.y + r),
                    control: CGPoint(x: center.x - waist, y: center.y + waist))
  path.closeSubpath()
  ctx.addPath(path)
  ctx.setFillColor(CGColor(red: 1, green: 1, blue: 1, alpha: alpha))
  ctx.fillPath()
}

sparkle(at: CGPoint(x: cx + size * 0.246, y: cy - size * 0.196), radius: size * 0.070, alpha: 0.97)
sparkle(at: CGPoint(x: cx + size * 0.336, y: cy - size * 0.302), radius: size * 0.032, alpha: 0.74)

// --- Écriture du PNG
guard let image = ctx.makeImage() else { fatalError("rendu impossible") }
let rep = NSBitmapImageRep(cgImage: image)
rep.size = NSSize(width: size, height: size)
guard let data = rep.representation(using: .png, properties: [:]) else { fatalError("encodage PNG impossible") }
try data.write(to: URL(fileURLWithPath: out))
print("icône écrite : \(out)")
