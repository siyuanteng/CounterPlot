import { useRef, useState } from "react";

/** Returns true only when value is a non-empty, non-whitespace string. */
const hasMediaSrc = (value?: string | null): value is string =>
  !!value && value.trim().length > 0;

type HoverMotionCardProps = {
  title: string;
  imageUrl: string;
  videoUrl?: string;
  className?: string;
};

export default function HoverMotionCard({
  title,
  imageUrl,
  videoUrl,
  className = "",
}: HoverMotionCardProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hovered, setHovered] = useState(false);

  const handleEnter = async () => {
    setHovered(true);

    if (videoRef.current) {
      try {
        videoRef.current.currentTime = 0;
        await videoRef.current.play();
      } catch (err) {
        console.error("Video autoplay failed:", err);
      }
    }
  };

  const handleLeave = () => {
    setHovered(false);

    if (videoRef.current) {
      videoRef.current.pause();
      videoRef.current.currentTime = 0;
    }
  };

  return (
    <div
      className={`relative overflow-hidden rounded-xl ${className}`}
      onMouseEnter={handleEnter}
      onMouseLeave={handleLeave}
    >
      {hasMediaSrc(imageUrl) && (
        <img
          src={imageUrl}
          alt={title}
          className="block w-full h-full object-cover"
        />
      )}

      {hasMediaSrc(videoUrl) && (
        <video
          ref={videoRef}
          src={videoUrl}
          muted
          loop
          playsInline
          preload="metadata"
          className={`absolute inset-0 w-full h-full object-cover transition-opacity duration-200 ${
            hovered ? "opacity-100" : "opacity-0"
          }`}
        />
      )}
    </div>
  );
}