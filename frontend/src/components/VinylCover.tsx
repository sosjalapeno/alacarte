import { motion } from 'framer-motion'

const VINYL_SRC = '/vinyl.webp'

export const vinylSpring = { type: 'spring' as const, stiffness: 213, damping: 33, mass: 1 }

type Props = {
  coverSrc?: string | null
  coverSrcSet?: string
  sizes?: string
  hovered: boolean
  onHoverChange: (hovered: boolean) => void
}

export function VinylCover({ coverSrc, coverSrcSet, sizes, hovered, onHoverChange }: Props) {
  return (
    <motion.div
      className="w-full"
      onHoverStart={() => onHoverChange(true)}
      onHoverEnd={() => onHoverChange(false)}
    >
      <motion.div
        className="relative aspect-square w-full"
        style={{ overflow: 'visible' }}
        initial={false}
        animate={{
          rotate: hovered ? -3 : 0,
          scale: hovered ? 1.03 : 1,
        }}
        transition={vinylSpring}
      >
        <motion.div
          className="absolute top-1/2 right-[2%] aspect-square w-[96%]"
          initial={false}
          animate={{
            x: hovered ? '45%' : '0%',
            y: '-50%',
            rotate: hovered ? 0 : -40,
          }}
          transition={vinylSpring}
        >
          <img
            src={VINYL_SRC}
            alt=""
            className="h-full w-full"
            draggable={false}
            loading="eager"
            decoding="async"
          />
          {coverSrc && (
            <img
              src={coverSrc}
              alt=""
              className="absolute left-1/2 top-[49%] w-[34%] aspect-square -translate-x-1/2 -translate-y-1/2 rounded-full object-cover"
              draggable={false}
              loading="lazy"
              decoding="async"
            />
          )}
        </motion.div>

        <div className="relative z-10 aspect-square w-full overflow-hidden rounded-app shadow-2xl ring-1 ring-white/10">
          {coverSrc && (
            <img
              src={coverSrc}
              srcSet={coverSrcSet}
              sizes={sizes}
              alt=""
              className="h-full w-full object-cover"
              loading="eager"
              decoding="async"
              fetchPriority="high"
            />
          )}
        </div>
      </motion.div>
    </motion.div>
  )
}
