import React, { useEffect, useMemo, useState } from "react";

/**
 * PixelMascot — the animated signature character for SolFair.
 *
 * pose:
 *  - "idle"  lottery open, nothing happening yet — gentle breathing bob
 *  - "walk"  draw is imminent / in progress — paces back and forth, anxious
 *  - "win"   this wallet won — jumps, arms up, confetti burst
 *  - "lose"  round completed, this wallet held a ticket but didn't win
 */
export default function PixelMascot({ pose = "idle", label }) {
  const [step, setStep] = useState(0);

  useEffect(() => {
    if (pose !== "walk") return undefined;
    const id = setInterval(() => setStep((s) => (s + 1) % 2), 260);
    return () => clearInterval(id);
  }, [pose]);

  const confetti = useMemo(() => {
    if (pose !== "win") return [];
    const colors = ["var(--gold)", "var(--teal)", "var(--red)", "#ffffff"];
    return Array.from({ length: 16 }, (_, i) => ({
      id: i,
      left: Math.round(Math.random() * 100),
      delay: (Math.random() * 0.5).toFixed(2),
      duration: (0.9 + Math.random() * 0.6).toFixed(2),
      color: colors[i % colors.length],
      rotate: Math.round(Math.random() * 360),
    }));
  }, [pose]);

  return (
    <div className={`mascotStage mascotStage--${pose}`} role="img" aria-label={label ?? pose}>
      <div className="mascotStage__frame">
        <span className="mascotStage__corner mascotStage__corner--tl" />
        <span className="mascotStage__corner mascotStage__corner--tr" />
        <span className="mascotStage__corner mascotStage__corner--bl" />
        <span className="mascotStage__corner mascotStage__corner--br" />

        <div className={`mascot mascot--${pose} ${pose === "walk" ? `mascot--step${step}` : ""}`}>
          <div className="mascot__cap" />
          <div className="mascot__head">
            <span className="mascot__eye mascot__eye--l" />
            <span className="mascot__eye mascot__eye--r" />
            <span className="mascot__mouth" />
          </div>
          <div className="mascot__torso">
            <span className="mascot__badge">◎</span>
            <span className="mascot__arm mascot__arm--l" />
            <span className="mascot__arm mascot__arm--r" />
          </div>
          <div className="mascot__legs">
            <span className="mascot__leg mascot__leg--l" />
            <span className="mascot__leg mascot__leg--r" />
          </div>
          <span className="mascot__shadow" />
        </div>

        {pose === "win" && (
          <div className="confetti" aria-hidden="true">
            {confetti.map((c) => (
              <span
                key={c.id}
                className="confetti__piece"
                style={{
                  left: `${c.left}%`,
                  animationDelay: `${c.delay}s`,
                  animationDuration: `${c.duration}s`,
                  background: c.color,
                  transform: `rotate(${c.rotate}deg)`,
                }}
              />
            ))}
          </div>
        )}
      </div>

      <p className="mascotStage__caption">
        {pose === "idle" && "Waiting for the round…"}
        {pose === "walk" && "Draw in progress…"}
        {pose === "win" && "You won! 🎉"}
        {pose === "lose" && "Not this round — good luck next time."}
      </p>
    </div>
  );
}
