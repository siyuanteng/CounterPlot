import React, { useState, useEffect, useRef, useCallback } from 'react';

/** Returns true only when value is a non-empty, non-whitespace string. */
const hasMediaSrc = (value?: string | null): value is string =>
  !!value && value.trim().length > 0;
import { motion, AnimatePresence } from 'motion/react';
import { AlertTriangle, Zap, ChevronRight, BookOpen, EyeOff, X, Mic } from 'lucide-react';
import { storyPacks, StoryPack, PlayerId } from './storyPacks';
import { buildCastTable, CastTable, DebugInfo } from './geminiShared';
import { generateTurnTextApi, generateImageApi, generateCoverApi, characterCanonApi, translateApi } from './services/api';
import { useGameState, useSocketGameState, createSocketRoom } from './store';
import { GameState, TurnData, Panel } from './types';
import { applyTurnImpact, buildTurnImpact, INITIAL_OUTCOME_FIELDS } from './outcomeEngine';

export default function App() {


  const [currentPath, setCurrentPath] = useState(window.location.pathname);
  const [currentSearch, setCurrentSearch] = useState(window.location.search);
  const [currentHash, setCurrentHash] = useState(window.location.hash);
  const [setupStory, setSetupStory] = useState<StoryPack | null>(null);

  useEffect(() => {
    const onLocationChange = () => {
      setCurrentPath(window.location.pathname);
      setCurrentSearch(window.location.search);
      setCurrentHash(window.location.hash);
    };
    window.addEventListener('popstate', onLocationChange);
    window.addEventListener('hashchange', onLocationChange);
    return () => {
      window.removeEventListener('popstate', onLocationChange);
      window.removeEventListener('hashchange', onLocationChange);
    };
  }, []);

  const params = new URLSearchParams(currentSearch || currentHash.split('?')[1] || '');
  const playerParam = params.get('player');
  const sessionParam = params.get('session');
  const tokenParam = params.get('token');

  const isPlayPath = currentPath.startsWith('/play') || currentHash.startsWith('#/play');

  if (isPlayPath || playerParam) {
    if ((playerParam === 'A' || playerParam === 'B') && sessionParam) {
      return <DuelView sessionId={sessionParam} playerId={playerParam as PlayerId} token={tokenParam} />;
    }
    return (
      <div className="h-screen w-full bg-[#0a0806] text-[#f4ebd8] flex flex-col items-center justify-center p-8 relative">
        <div className="absolute inset-0 pointer-events-none opacity-50 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E")` }}></div>
        <div className="max-w-md w-full bg-[#1a110c] border border-[#8a6331]/30 rounded-sm p-8 shadow-2xl text-center relative z-10">
          <AlertTriangle className="w-12 h-12 text-[#d1a561] mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2 text-[#d1a561]">Invalid Duel Link</h2>
          <p className="text-[#a87b38] mb-8 text-sm">The link is missing a player identity or session ID.</p>
          <button 
            onClick={() => { window.location.href = '/'; }}
            className="w-full py-3 bg-[#2c1e16] text-[#f4ebd8] text-xs font-bold rounded-sm shadow-md hover:bg-[#3d2a1f] transition-all tracking-[0.2em] uppercase border border-[#8a6331]/50"
          >
            Return to Story Shelf
          </button>
        </div>
      </div>
    );
  }

  if (setupStory) {
    return <SetupView story={setupStory} onBack={() => setSetupStory(null)} />;
  }

  return (
    <div className="h-screen w-full bg-[#0a0806] text-[#f4ebd8] font-sans overflow-hidden">
      <LibraryView onSelect={(story) => setSetupStory(story)} />
    </div>
  );
}

const tutorialStory: StoryPack = {
  id: 'tutorial',
  title: 'Duel Manual',
  hook: 'This is not about who writes more, but who steers the story more effectively.',
  prologue: 'Welcome to Counterplot. You are not playing a character — you are directing the story from outside. Each round, write a narrative intent: what you want to happen next. The engine reads both players\' intents and continues the scene. Master the art of steering, and the ending is yours.',
  tags: ['Tutorial', 'Required Reading'],
  coverUrl: '/covers/tutorial.jpg',
  characterIdentityLock: '',
  visualStyleLock: '',
  anchors: [],
  playerA: { id: 'A', defaultName: '', avatar: '', goal: '', sideQuest: '', sideQuestHint: '' },
  playerB: { id: 'B', defaultName: '', avatar: '', goal: '', sideQuest: '', sideQuestHint: '' }
};

const getPromptForStory = (id: string) => {
  if (id === 'neon-shadow') return 'A cyberpunk book cover, year 2142, deep underground cooling server room, two agents in tactical gear, one with glowing blue visor, one with mechanical arm, red alarm lights, ozone mist, high contrast, cinematic lighting, no text.';
  if (id === 'echoes-of-the-abyss') return 'A deep sea horror book cover, Mariana Trench, high water pressure, a deep sea diver in heavy yellow suit facing a dark submarine airlock, creepy underwater atmosphere, glowing bioluminescence, cinematic lighting, no text.';
  if (id === 'tutorial') return '';
  return '';
};

function LibraryView({ onSelect }: { onSelect: (story: StoryPack) => void }) {
  const [tutorialSeen, setTutorialSeen] = useState(() => {
    return localStorage.getItem('storyRelay:tutorialSeen') === 'true';
  });
  const [hoveredStory, setHoveredStory] = useState<string | null>(null);
  const [readingBook, setReadingBook] = useState<StoryPack | null>(null);
  const [isBookOpen, setIsBookOpen] = useState(false);
  const [stories, setStories] = useState<StoryPack[]>([tutorialStory, ...storyPacks]);
  const [isGenerating, setIsGenerating] = useState(false);

  useEffect(() => {
    if (readingBook) {
      const timer = setTimeout(() => setIsBookOpen(true), 280);
      return () => clearTimeout(timer);
    } else {
      setIsBookOpen(false);
    }
  }, [readingBook]);


  useEffect(() => {
    const loadAndGenerateCovers = async () => {
      let updatedStories = [tutorialStory, ...storyPacks];
      let needsUpdate = false;

      for (let i = 0; i < updatedStories.length; i++) {
        const story = updatedStories[i];
        const cachedCover = localStorage.getItem(`cover_v2_${story.id}`);
        if (cachedCover) {
          updatedStories[i] = { ...story, coverUrl: cachedCover };
          needsUpdate = true;
        }
      }

      if (needsUpdate) {
        setStories(updatedStories);
      }

      // Check if we need to generate any
      const needsGeneration = updatedStories.some(s => !localStorage.getItem(`cover_v2_${s.id}`) && getPromptForStory(s.id) !== '');
      if (needsGeneration && !isGenerating) {
        setIsGenerating(true);
        for (let i = 0; i < updatedStories.length; i++) {
          const story = updatedStories[i];
          if (!localStorage.getItem(`cover_v2_${story.id}`)) {
            const prompt = getPromptForStory(story.id);
            if (prompt) {
              const newCover = await generateCoverApi(prompt);
              if (newCover) {
                localStorage.setItem(`cover_v2_${story.id}`, newCover);
                setStories(prev => prev.map(s => s.id === story.id ? { ...s, coverUrl: newCover } : s));
              }
            }
          }
        }
        setIsGenerating(false);
      }
    };

    loadAndGenerateCovers();
  }, []);


  const closeBook = () => {
    setIsBookOpen(false);
    setTimeout(() => {
      if (readingBook?.id === 'tutorial') {
        setTutorialSeen(true);
        localStorage.setItem('storyRelay:tutorialSeen', 'true');
      }
      setReadingBook(null);
    }, 520);
  };

  return (
    <div className="h-full w-full bg-[#0a0806] text-[#f4ebd8] font-sans overflow-y-auto relative perspective-1000">
      {/* Ambient Lighting */}
      <div className="fixed inset-0 pointer-events-none z-0">
        <div className="absolute top-0 left-1/4 w-1/2 h-96 bg-[#ffeedd]/5 blur-[120px] rounded-full mix-blend-screen" />
        <div className="absolute bottom-0 right-1/4 w-1/3 h-64 bg-[#ffeedd]/5 blur-[100px] rounded-full mix-blend-screen" />
      </div>

      {/* Top Nav */}
      <nav className="fixed top-0 left-0 right-0 p-6 flex justify-between items-center z-50 bg-gradient-to-b from-[#0a0806] to-transparent pointer-events-none">
        <div className="flex items-center gap-3 pointer-events-auto">
          <BookOpen className="w-6 h-6 text-[#d4af37]" />
          <h1 className="text-2xl font-black tracking-widest text-[#d4af37] uppercase" style={{ fontFamily: 'Cinzel Decorative, serif' }}>Counterplot</h1>
        </div>
      </nav>


      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 pt-32 pb-24 relative z-10 min-h-screen flex flex-col">
        
        {/* Bookshelf Container */}
        <div className="flex-1 flex flex-col justify-center relative mt-12">
          
          {/* The Shelf Structure */}
          <div className="relative w-full max-w-5xl mx-auto">
            {/* Back panel of shelf */}
            <div 
              className="absolute inset-0 bg-[#e4c596] rounded-sm shadow-[inset_0_20px_40px_rgba(0,0,0,0.3)] border-8 border-[#d1a561] -z-20 overflow-hidden" 
              style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }} 
            >
              {/* Spotlights */}
              <div className="absolute top-0 left-1/4 w-40 h-64 bg-white/40 blur-[30px] rounded-full transform -translate-x-1/2 -translate-y-1/4" style={{ clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
              <div className="absolute top-0 left-2/4 w-40 h-64 bg-white/40 blur-[30px] rounded-full transform -translate-x-1/2 -translate-y-1/4" style={{ clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
              <div className="absolute top-0 left-3/4 w-40 h-64 bg-white/40 blur-[30px] rounded-full transform -translate-x-1/2 -translate-y-1/4" style={{ clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' }} />
              
              {/* Spotlight fixtures */}
              <div className="absolute top-0 left-1/4 w-6 h-2 bg-gradient-to-b from-[#d1a561] to-[#8a6331] rounded-b-md shadow-md transform -translate-x-1/2" />
              <div className="absolute top-0 left-2/4 w-6 h-2 bg-gradient-to-b from-[#d1a561] to-[#8a6331] rounded-b-md shadow-md transform -translate-x-1/2" />
              <div className="absolute top-0 left-3/4 w-6 h-2 bg-gradient-to-b from-[#d1a561] to-[#8a6331] rounded-b-md shadow-md transform -translate-x-1/2" />
            </div>
            
            {/* Shelf Board */}
            <div 
              className="absolute bottom-0 left-[-2%] right-[-2%] h-8 bg-gradient-to-b from-[#f3d5a2] via-[#d1a561] to-[#a87b38] rounded-sm shadow-[0_20px_40px_rgba(0,0,0,0.4),inset_0_2px_0_rgba(255,255,255,0.4)] border-t border-[#fce4b8] border-b-2 border-[#8a6331] -z-10 transform translate-y-full" 
              style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }}
            >
            </div>

            {/* Left Side Panel */}
            <div 
              className="absolute top-[-4%] bottom-[-24px] left-[-2%] w-6 bg-gradient-to-r from-[#d1a561] to-[#a87b38] border-r border-black/20 shadow-[5px_0_15px_rgba(0,0,0,0.2)] -z-15" 
              style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }} 
            />
            
            {/* Right Side Panel */}
            <div 
              className="absolute top-[-4%] bottom-[-24px] right-[-2%] w-6 bg-gradient-to-l from-[#d1a561] to-[#a87b38] border-l border-black/20 shadow-[-5px_0_15px_rgba(0,0,0,0.2)] -z-15" 
              style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }} 
            />
            
            {/* Top Panel */}
            <div 
              className="absolute top-[-4%] left-[-2%] right-[-2%] h-6 bg-gradient-to-b from-[#a87b38] to-[#d1a561] border-b border-black/20 shadow-[0_5px_15px_rgba(0,0,0,0.2)] -z-15" 
              style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/wood-pattern.png")' }} 
            />
            
            {/* Books Container */}
            <div className="flex items-end justify-center gap-8 sm:gap-12 px-8 pt-16 pb-2 relative z-10 min-h-[400px]">
              
              {/* Story Books */}
              {stories.map((story) => {
                const isHovered = hoveredStory === story.id;
                const isReading = readingBook?.id === story.id;

                return (
                  <div key={story.id} className="relative perspective-1000" style={{ zIndex: isHovered ? 30 : 10 }}>
                    <motion.div
                      layoutId={`book-container-${story.id}`}
                      className="w-[180px] h-[270px] sm:w-[200px] sm:h-[300px] cursor-pointer transform-style-3d origin-bottom"
                      animate={{
                        y: isHovered && !isReading ? -10 : 0,
                        rotateY: isHovered && !isReading ? -5 : 0,
                        z: isHovered && !isReading ? 20 : 0,
                      }}
                      transition={{ type: "spring", stiffness: 300, damping: 30 }}
                      onHoverStart={() => setHoveredStory(story.id)}
                      onHoverEnd={() => setHoveredStory(null)}
                      onClick={() => {
                        if (!readingBook) setReadingBook(story);
                      }}
                      style={{ opacity: isReading ? 0 : 1 }}
                    >
                      {/* Book Shadow */}
                      <motion.div 
                        className="absolute bottom-0 left-0 right-0 h-4 bg-black/60 blur-md rounded-full -z-10"
                        animate={{
                          opacity: isHovered ? 0.8 : 0.4,
                          scale: isHovered ? 1.1 : 1,
                          y: isHovered ? 15 : 5
                        }}
                      />

                      {/* Cover */}
                      <div className="absolute inset-0 bg-[#1a110c] rounded-r-md rounded-l-sm overflow-hidden shadow-[5px_5px_15px_rgba(0,0,0,0.5),inset_4px_0_10px_rgba(0,0,0,0.5),inset_0_0_0_1px_rgba(255,255,255,0.05)]">
                        {story.id === 'tutorial' ? (
                          <div className="w-full h-full flex flex-col items-center justify-center relative"
                            style={{ background: 'linear-gradient(160deg, #c8a96e 0%, #b8945a 30%, #a07840 60%, #b89458 100%)' }}>
                            {/* Paper grain texture */}
                            <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/old-paper.png")' }} />
                            {/* Outer border */}
                            <div className="absolute inset-3 border border-[#7a5828]/50" />
                            {/* Inner border */}
                            <div className="absolute inset-[14px] border border-[#7a5828]/30" />
                            {/* Corner ornaments */}
                            {['top-[10px] left-[10px]','top-[10px] right-[10px] rotate-90','bottom-[10px] left-[10px] -rotate-90','bottom-[10px] right-[10px] rotate-180'].map((cls, i) => (
                              <svg key={i} className={`absolute ${cls} w-5 h-5 text-[#7a5828]/60`} viewBox="0 0 20 20" fill="none">
                                <path d="M2 2 L2 8 M2 2 L8 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              </svg>
                            ))}
                            {/* Center ornament */}
                            <svg className="w-10 h-10 text-[#7a5828]/50 mb-3 relative z-10" viewBox="0 0 40 40" fill="none">
                              <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="1"/>
                              <circle cx="20" cy="20" r="9" stroke="currentColor" strokeWidth="0.5"/>
                              <path d="M20 6 L20 34 M6 20 L34 20" stroke="currentColor" strokeWidth="0.5"/>
                              <path d="M20 6 L22 10 L20 8 L18 10 Z" fill="currentColor"/>
                            </svg>
                            <div className="relative z-10 text-center px-4">
                              <div className="text-[8px] uppercase tracking-[0.3em] text-[#7a5828]/70 mb-1">— Field Notes —</div>
                            </div>
                          </div>
                        ) : hasMediaSrc(story.coverUrl) ? (
                          <img src={story.coverUrl} alt={story.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                        ) : (
                          <div className="w-full h-full bg-[#1a110c]" />
                        )}
                        <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent mix-blend-multiply" />
                        <div className="absolute left-0 top-0 bottom-0 w-3 bg-gradient-to-r from-black/60 to-transparent" />
                        <div className="absolute left-3 top-0 bottom-0 w-[1px] bg-white/10" />

                        {/* Highlight for tutorial */}
                        {story.id === 'tutorial' && !tutorialSeen && (
                          <div className="absolute inset-0 shadow-[inset_0_0_40px_rgba(212,175,55,0.8)] animate-pulse pointer-events-none" />
                        )}

                        {/* Title Area */}
                        <div className="absolute bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-black via-black/90 to-transparent">
                          <h3 className="text-xl font-bold text-white mb-2 drop-shadow-lg">{story.title}</h3>
                          <div className="flex gap-1 flex-nowrap overflow-hidden">
                            {story.tags.slice(0, 2).map(tag => (
                              <span key={tag} className="px-1 py-0.5 bg-black/50 backdrop-blur-sm border border-white/10 text-[#f4ebd8] text-[9px] font-medium rounded uppercase tracking-wider whitespace-nowrap">{tag}</span>
                            ))}
                          </div>
                        </div>
                      </div>
                    </motion.div>
                  </div>
                );
              })}
            </div>

            {/* Reading Modal */}
            <AnimatePresence>
              {readingBook && (
                <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none perspective-1000">
                  {/* Backdrop */}
                  <motion.div 
                    initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                    className="absolute inset-0 bg-black/60 backdrop-blur-sm pointer-events-auto"
                    onClick={closeBook}
                  />
                  
                  {/* The Opened Book */}
                  <motion.div
                    layoutId={`book-container-${readingBook.id}`}
                    className="relative h-[450px] pointer-events-auto"
                    style={{ perspective: 1200 }}
                    initial={false}
                    animate={{ width: isBookOpen ? (readingBook.id === 'tutorial' ? 640 : 720) : 300 }}
                    transition={{ type: 'tween', ease: [0.4, 0, 0.2, 1], duration: 0.48, delay: isBookOpen ? 0 : 0.12 }}
                  >
                    {/* Right Page (Base) */}
                    <motion.div
                      className={`absolute top-0 right-0 h-full overflow-hidden z-10 ${readingBook.id === 'tutorial' ? 'bg-[#f0e6cc] shadow-2xl' : 'bg-[#f4ebd8] rounded-r-md shadow-2xl'}`}
                      initial={false}
                      animate={{ width: isBookOpen ? (readingBook.id === 'tutorial' ? 640 : 360) : 300 }}
                      transition={{ type: 'tween', ease: [0.4, 0, 0.2, 1], duration: 0.48, delay: isBookOpen ? 0 : 0.12 }}
                    >
                      {readingBook.id === 'tutorial' ? (
                        /* Single container: full landscape image on top, title + description below.
                           Content hidden until cover flip completes to avoid the mid-flip overlap. */
                        <motion.div
                          className="w-full h-full flex flex-col"
                          animate={{ opacity: isBookOpen ? 1 : 0 }}
                          transition={{ duration: 0.2, delay: isBookOpen ? 0.52 : 0 }}
                        >
                          <div className="flex-1 relative min-h-0">
                            <img
                              src="/covers/tutorial-guide.jpg"
                              alt="Tutorial Explanation"
                              className="absolute inset-0 w-full h-full object-cover object-top"
                            />
                            <div className="absolute bottom-0 left-0 right-0 h-12 bg-gradient-to-t from-[#f0e6cc] to-transparent pointer-events-none" />
                          </div>
                          <div className="shrink-0 bg-[#f0e6cc] px-8 pb-6 pt-2 text-center">
                            <h4 className="text-base font-bold text-[#2c1e16] mb-2">How Counterplot Works</h4>
                            <p className="text-xs text-[#5a4024] leading-relaxed">
                              You are not a character. You are a story director writing from outside the scene.
                              Each round, write a narrative intent — what the story should do next, not what your character does.
                              The engine reads both players' intents and continues the scene.
                              The ending belongs to whoever steers the narrative more effectively.
                            </p>
                          </div>
                        </motion.div>
                      ) : (
                        <>
                          {/* Right page spine shadow */}
                          <div className="absolute left-0 top-0 bottom-0 w-12 bg-gradient-to-r from-black/10 to-transparent pointer-events-none mix-blend-multiply z-10" />
                          <InteriorRightPage story={readingBook} onStart={() => onSelect(readingBook)} />
                        </>
                      )}

                      {/* Close Button */}
                      <button
                        onClick={closeBook}
                        className={`absolute top-4 right-4 p-1.5 rounded-full transition-colors z-50 ${
                          readingBook.id === 'tutorial'
                            ? 'text-[#0a0806] bg-white/80 hover:bg-white shadow-sm'
                            : 'text-[#8a6331] hover:text-[#5a4024] hover:bg-[#8a6331]/10'
                        }`}
                      >
                        <X className="w-5 h-5" />
                      </button>
                    </motion.div>

                    {/* Left Page (Cover & Inside Left) — pointer-events-none when open so flipped cover never blocks clicks */}
                    <motion.div
                      className="absolute top-0 right-0 h-full origin-left z-20"
                      style={{ transformStyle: 'preserve-3d', pointerEvents: isBookOpen ? 'none' : 'auto' }}
                      initial={false}
                      animate={{
                        width: isBookOpen ? (readingBook.id === 'tutorial' ? 300 : 360) : 300,
                        rotateY: isBookOpen ? -180 : 0
                      }}
                      transition={{
                        rotateY: {
                          type: 'spring',
                          stiffness: 160,
                          damping: 36,
                          delay: isBookOpen ? 0.14 : 0,
                        },
                        width: { type: 'tween', ease: [0.4, 0, 0.2, 1], duration: 0.48, delay: isBookOpen ? 0 : 0.12 },
                      }}
                    >
                      {/* Front Cover */}
                      <div
                        className="absolute inset-0 bg-[#1a110c] rounded-r-md rounded-l-sm overflow-hidden shadow-[20px_20px_40px_rgba(0,0,0,0.8),inset_4px_0_10px_rgba(0,0,0,0.5),inset_0_0_0_1px_rgba(255,255,255,0.1)]"
                        style={{ backfaceVisibility: 'hidden' }}
                      >
                        {readingBook.id === 'tutorial' ? (
                          <div className="w-full h-full flex flex-col items-center justify-center relative"
                            style={{ background: 'linear-gradient(160deg, #c8a96e 0%, #b8945a 30%, #a07840 60%, #b89458 100%)' }}>
                            <div className="absolute inset-0 opacity-30" style={{ backgroundImage: 'url("https://www.transparenttextures.com/patterns/old-paper.png")' }} />
                            <div className="absolute inset-3 border border-[#7a5828]/50" />
                            <div className="absolute inset-[14px] border border-[#7a5828]/30" />
                            {['top-[10px] left-[10px]','top-[10px] right-[10px] rotate-90','bottom-[10px] left-[10px] -rotate-90','bottom-[10px] right-[10px] rotate-180'].map((cls, i) => (
                              <svg key={i} className={`absolute ${cls} w-5 h-5 text-[#7a5828]/60`} viewBox="0 0 20 20" fill="none">
                                <path d="M2 2 L2 8 M2 2 L8 2" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
                              </svg>
                            ))}
                            <svg className="w-10 h-10 text-[#7a5828]/50 mb-3 relative z-10" viewBox="0 0 40 40" fill="none">
                              <circle cx="20" cy="20" r="14" stroke="currentColor" strokeWidth="1"/>
                              <circle cx="20" cy="20" r="9" stroke="currentColor" strokeWidth="0.5"/>
                              <path d="M20 6 L20 34 M6 20 L34 20" stroke="currentColor" strokeWidth="0.5"/>
                              <path d="M20 6 L22 10 L20 8 L18 10 Z" fill="currentColor"/>
                            </svg>
                            <div className="relative z-10 text-center px-4">
                              <div className="text-[8px] uppercase tracking-[0.3em] text-[#7a5828]/70 mb-1">— Field Notes —</div>
                              <div className="text-base font-bold text-[#5a3e1a]">Duel Manual</div>
                            </div>
                          </div>
                        ) : (
                          <>
                            {hasMediaSrc(readingBook.coverUrl)
                              ? <img src={readingBook.coverUrl} alt={readingBook.title} className="w-full h-full object-cover" referrerPolicy="no-referrer" />
                              : <div className="w-full h-full bg-[#1a110c]" />
                            }
                            <div className="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent mix-blend-multiply" />
                            <div className="absolute left-0 top-0 bottom-0 w-3 bg-gradient-to-r from-black/60 to-transparent" />
                            <div className="absolute left-3 top-0 bottom-0 w-[1px] bg-white/10" />
                            <div className="absolute bottom-0 left-0 right-0 p-6 bg-gradient-to-t from-black via-black/90 to-transparent">
                              <h3 className="text-2xl font-bold text-white mb-2 drop-shadow-lg">{readingBook.title}</h3>
                              <p className="text-[#f4ebd8] text-sm leading-relaxed mb-3 line-clamp-3 opacity-90">{readingBook.prologue}</p>
                              <div className="flex gap-1.5 flex-wrap">
                                {readingBook.tags.slice(0, 3).map(tag => (
                                  <span key={tag} className="px-1.5 py-0.5 bg-black/50 backdrop-blur-sm border border-white/10 text-[#f4ebd8] text-[10px] font-medium rounded uppercase tracking-wider">{tag}</span>
                                ))}
                              </div>
                            </div>
                          </>
                        )}
                      </div>

                      {/* Inside Left Page */}
                      <div
                        className={`absolute inset-0 rounded-l-md overflow-hidden ${readingBook.id === 'tutorial' ? '' : 'bg-[#f4ebd8]'}`}
                        style={{ backfaceVisibility: 'hidden', transform: 'rotateY(180deg)' }}
                      >
                        {readingBook.id === 'tutorial' ? null : (
                          <>
                            <InteriorLeftPage story={readingBook} />
                            <div className="absolute right-0 top-0 bottom-0 w-10 bg-gradient-to-r from-transparent to-black/10 pointer-events-none mix-blend-multiply" />
                          </>
                        )}
                      </div>
                    </motion.div>
                  </motion.div>
                </div>
              )}
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}

function StepCard({ number, title, description }: { number: string, title: string, description: string }) {
  return (
    <div className="flex flex-col gap-3">
      <div className="text-xs text-indigo-400/80 bg-indigo-500/10 w-fit px-2 py-1 rounded">{number}</div>
      <h3 className="text-base font-bold text-[#d1a561]">{title}</h3>
      <p className="text-sm text-[#a87b38] leading-relaxed">{description}</p>
    </div>
  );
}

const PLAYER_AVATAR: Record<'A' | 'B', string> = { A: '🥷', B: '👷' };

function PlayerAvatar({ playerId, size = 'md' }: { playerId: 'A' | 'B', size?: 'sm' | 'md' | 'lg' }) {
  const emoji = PLAYER_AVATAR[playerId];
  const cls = size === 'lg' ? 'text-3xl' : size === 'sm' ? 'text-lg' : 'text-2xl';
  return <span className={cls} role="img" aria-label={`Player ${playerId}`}>{emoji}</span>;
}


function InteriorLeftPage({ story }: { story: StoryPack }) {
  return (
    <div className="w-full h-full relative p-8 flex flex-col items-center justify-center bg-[#f4ebd8]">
      {/* Paper Texture */}
      <div className="absolute inset-0 pointer-events-none opacity-50 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E")` }}></div>
      
      {/* Image Container with Passepartout effect */}
      <div className="w-full h-full relative rounded-sm shadow-[0_4px_15px_rgba(0,0,0,0.15),0_1px_3px_rgba(0,0,0,0.1)] overflow-hidden border border-[#d1bfae]/50 bg-[#1a110c]">
        {hasMediaSrc(story.coverUrl) && (
          <img src={story.coverUrl} alt={story.title} className="absolute inset-0 w-full h-full object-cover opacity-95" />
        )}
        <div className="absolute inset-0 bg-gradient-to-tr from-black/20 to-transparent pointer-events-none mix-blend-multiply" />
      </div>
    </div>
  );
}

function InteriorRightPage({ story, onStart }: { story: StoryPack, onStart: () => void }) {
  return (
    <div className="flex flex-col h-full relative p-8 bg-[#f4ebd8]">
      {/* Paper Texture */}
      <div className="absolute inset-0 pointer-events-none opacity-50 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E")` }}></div>

      {/* Decorative Border */}
      <div className="absolute inset-5 border border-[#8a6331]/20 pointer-events-none rounded-sm" />
      <div className="absolute inset-[22px] border border-[#8a6331]/10 pointer-events-none rounded-sm" />

      {/* Corner Ornaments */}
      <div className="absolute top-4 left-4 w-2 h-2 border-t border-l border-[#8a6331]/40" />
      <div className="absolute top-4 right-4 w-2 h-2 border-t border-r border-[#8a6331]/40" />
      <div className="absolute bottom-4 left-4 w-2 h-2 border-b border-l border-[#8a6331]/40" />
      <div className="absolute bottom-4 right-4 w-2 h-2 border-b border-r border-[#8a6331]/40" />

      <div className="flex-1 flex flex-col items-center justify-center text-center z-10 px-4">
        {/* Small emblem */}
        <div className="w-6 h-6 mb-6 text-[#8a6331] opacity-80">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" className="w-full h-full">
            <path d="M12 2L15 8L22 9L17 14L18 21L12 17.5L6 21L7 14L2 9L9 8L12 2Z" strokeLinejoin="round"/>
          </svg>
        </div>

        <h2 className="text-2xl font-bold text-[#2c1e16] mb-4 leading-tight">
          {story.title}
        </h2>
        
        <div className="w-12 h-[1px] bg-[#8a6331]/30 mb-5" />
        
        <p className="text-[#5a4024] text-sm leading-relaxed mb-6 font-medium">
          "{story.hook}"
        </p>

        <div className="flex gap-2 flex-wrap justify-center">
          {story.tags.map(tag => (
            <span key={tag} className="px-2 py-1 bg-[#8a6331]/5 text-[#8a6331] border border-[#8a6331]/20 text-[9px] font-bold rounded-sm uppercase tracking-widest">
              {tag}
            </span>
          ))}
        </div>
      </div>

      <div className="mt-auto pt-4 z-10 px-2">
        <button
          onClick={onStart}
          className="w-full py-3 bg-[#2c1e16] text-[#f4ebd8] text-xs font-bold rounded shadow-md hover:bg-[#1a110c] transition-all transform hover:scale-[1.02] active:scale-[0.98] tracking-[0.2em] uppercase border border-[#4a3320]"
        >
          Enter the Duel
        </button>
      </div>
    </div>
  );
}

function SetupView({ story, onBack }: { story: StoryPack, onBack: () => void }) {
  const [playerA, setPlayerA] = useState(story.playerA.defaultName);
  const [playerB, setPlayerB] = useState(story.playerB.defaultName);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [seatTokens, setSeatTokens] = useState<{ A: string; B: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [copiedSeat, setCopiedSeat] = useState<'A' | 'B' | null>(null);

  const handleCreate = () => {
    setCreating(true);
    setCreateError(null);

    const baseState: GameState = {
      sessionId: '',   // overwritten with server-assigned roomId in onCreated
      storyId: story.id,
      playerAName: playerA,
      playerBName: playerB,
      currentTurn: 1,
      currentPlayer: 'A',
      progressA: 50,
      credibility: 70,
      evidenceState: 'unknown',
      mediaState: 'none',
      trustState: 'distant',
      currentHook: '',
      storyboard: [
        {
          id: 'prologue',
          turn: 0,
          player: 'System',
          text: story.prologue,
          panels: [{ imageUrl: story.coverUrl, caption: 'Prologue' }],
        },
      ],
      lastIntentByPlayer: {},
      isGameOver: false,
      outcome: INITIAL_OUTCOME_FIELDS,
      sideQuestEarned: { A: false, B: false },
    };

    createSocketRoom(
      baseState,
      (roomId, tokenA, tokenB) => {
        setSeatTokens({ A: tokenA, B: tokenB });
        setSessionId(roomId);
        setCreating(false);
      },
      (msg) => {
        setCreateError(msg);
        setCreating(false);
      },
    );
  };

  const seatLink = (label: 'A' | 'B') =>
    `${window.location.origin}/?player=${label}&session=${sessionId}&token=${seatTokens?.[label] ?? ''}`;

  return (
    <div className="h-screen w-full bg-[#0a0806] text-[#f4ebd8] flex flex-col items-center justify-center p-8 overflow-y-auto relative">
      {/* Ambient Lighting */}
      <div className="absolute inset-0 pointer-events-none opacity-50 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E")` }}></div>

      <div className="max-w-xl w-full bg-[#f4ebd8] border border-[#8a6331]/30 rounded-sm p-10 shadow-2xl relative z-10 text-[#2c1e16]">
        {/* Decorative Border */}
        <div className="absolute inset-4 border border-[#8a6331]/20 pointer-events-none rounded-sm" />
        <div className="absolute inset-5 border border-[#8a6331]/10 pointer-events-none rounded-sm" />

        <button onClick={onBack} className="text-[#8a6331] hover:text-[#5a4024] mb-6 flex items-center gap-2 text-xs uppercase tracking-widest font-bold relative z-20">
          &larr; Return to Shelf
        </button>

        <h1 className="text-3xl font-bold mb-2 text-center">{story.title}</h1>
        {sessionId && <p className="text-[#8a6331] mb-8 text-center text-xs">Open the links below in separate tabs or send to another device.</p>}
        {!sessionId && <div className="mb-8" />}

        {!sessionId ? (
          <div className="space-y-6 relative z-20">
            <div>
              <label className="block text-xs font-bold text-[#8a6331] mb-2 uppercase tracking-widest">Player A ({story.playerA.defaultName})</label>
              <input
                type="text"
                value={playerA}
                onChange={e => setPlayerA(e.target.value)}
                className="w-full bg-[#ffeedd]/50 border border-[#8a6331]/30 rounded-sm p-3 text-[#2c1e16] focus:outline-none focus:border-[#8a6331]"
              />
            </div>
            <div>
              <label className="block text-xs font-bold text-[#8a6331] mb-2 uppercase tracking-widest">Player B ({story.playerB.defaultName})</label>
              <input
                type="text"
                value={playerB}
                onChange={e => setPlayerB(e.target.value)}
                className="w-full bg-[#ffeedd]/50 border border-[#8a6331]/30 rounded-sm p-3 text-[#2c1e16] focus:outline-none focus:border-[#8a6331]"
              />
            </div>
            {createError && (
              <p className="text-red-600 text-xs text-center">{createError}</p>
            )}
            <button
              onClick={handleCreate}
              disabled={creating}
              className="w-full py-3 bg-[#2c1e16] text-[#f4ebd8] text-xs font-bold rounded-sm shadow-md hover:bg-[#1a110c] transition-all tracking-[0.2em] uppercase border border-[#4a3320] mt-4 disabled:opacity-50"
            >
              {creating ? 'Creating Room…' : 'Initialize Session'}
            </button>
          </div>
        ) : (
          <div className="space-y-3 animate-in fade-in slide-in-from-bottom-4 relative z-20">
            {(['A', 'B'] as const).map(label => {
              const name = label === 'A' ? playerA : playerB;
              const href = seatLink(label);
              return (
                <div key={label} className="flex items-center justify-between py-3 px-4 border-b border-[#8a6331]/20 last:border-b-0">
                  <span className="text-sm font-bold text-[#2c1e16]">
                    Player {label}: {name}
                  </span>
                  <div className="flex items-center gap-3 ml-4">
                    <button
                      type="button"
                      onClick={() => {
                        const fallback = () => {
                          const ta = document.createElement('textarea');
                          ta.value = href;
                          ta.style.position = 'fixed';
                          ta.style.opacity = '0';
                          document.body.appendChild(ta);
                          ta.select();
                          document.execCommand('copy');
                          document.body.removeChild(ta);
                        };
                        (navigator.clipboard
                          ? navigator.clipboard.writeText(href).catch(fallback)
                          : Promise.resolve(fallback())
                        ).then(() => {
                          setCopiedSeat(label);
                          setTimeout(() => setCopiedSeat(null), 1500);
                        });
                      }}
                      className="text-xs text-[#8a6331] hover:text-[#5a4024] uppercase tracking-widest transition-colors cursor-pointer"
                      title="Copy link for another device"
                    >
                      {copiedSeat === label ? 'Copied!' : 'Copy'}
                    </button>
                    <a
                      href={href}
                      target="_blank"
                      rel="noreferrer"
                      className="text-xs font-bold text-[#8a6331] hover:text-[#5a4024] uppercase tracking-widest transition-colors whitespace-nowrap"
                    >
                      Enter &rarr;
                    </a>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}


function DuelView({ sessionId, playerId, token }: { sessionId: string, playerId: PlayerId, token: string | null }) {
  // Socket mode when a seat token is present in the URL; local mode otherwise.
  // Both hooks are called unconditionally to satisfy React's rules of hooks.
  const socketResult = useSocketGameState(sessionId, playerId, token);
  const localResult  = useGameState(token ? null : sessionId);
  const { gameState, updateGameState, error, loading } = token ? socketResult : localResult;
  const [intentGoalType, setIntentGoalType] = useState<'main' | 'side'>('main');
  const [intentTone, setIntentTone] = useState('Calm');
  const INTENT_TEMPLATE = '// Scene Direction\n\n\n// Constraints\n\n\n// Rules\n';
  const [intentBody, setIntentBody] = useState(INTENT_TEMPLATE);
  const [inspirations, setInspirations] = useState<string[]>([]);
  const [inspirationIdx, setInspirationIdx] = useState(0);
  const [showInspiration, setShowInspiration] = useState(false);
  const [loadingInspirations, setLoadingInspirations] = useState(false);
  const [showOpponentCard, setShowOpponentCard] = useState(false);
  const [isVoiceActive, setIsVoiceActive] = useState(false);
  const [voiceInterim, setVoiceInterim] = useState('');
  const [showOutcomeModal, setShowOutcomeModal] = useState(false);
  const [showEndingFrame, setShowEndingFrame] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [inProgressCard, setInProgressCard] = useState<TurnData | null>(null);
  const TURN_SECONDS = 180;
  const [timeLeft, setTimeLeft] = useState(TURN_SECONDS);
  const [debugInfo, setDebugInfo] = useState<DebugInfo | null>(null);
  const [showBriefing, setShowBriefing] = useState(true);

  const storyboardRef = useRef<HTMLElement>(null);
  const worldRef = useRef<HTMLDivElement>(null);
  const lastRowRef = useRef<HTMLDivElement>(null);
  const generatingRef = useRef<HTMLDivElement>(null);
  const recRef = useRef<any>(null);
  const panRef = useRef({ x: 0, y: 0 });
  const dragStartRef = useRef<{ mouseX: number; mouseY: number; panX: number; panY: number } | null>(null);
  const isSpaceDownRef = useRef(false);
  const handleAutoSubmitRef = useRef<() => void>(() => {});
  const prevStoryLenRef = useRef(0);
  const castTableRef = useRef<CastTable>(buildCastTable({}, '', ''));
  const cardRefs = useRef<Record<string, HTMLDivElement | null>>({});
  const [focusedCardId, setFocusedCardId] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const [spaceReady, setSpaceReady] = useState(false);
  const [translatedTexts, setTranslatedTexts] = useState<Record<string, string>>({});
  const [isTranslating, setIsTranslating] = useState(false);
  const [showTranslation, setShowTranslation] = useState(false);

  // ── Motion clip state (dev/MVP — local only, not synced) ──────────────────
  type ClipState = { status: 'pending' | 'done' | 'error'; jobId?: string; clipUrl?: string; errorMsg?: string };
  const [clips, setClips] = useState<Record<string, ClipState>>({});
  // Per-card: true after user has hovered the frame at least once
  const [hintDismissed, setHintDismissed] = useState<Record<string, boolean>>({});

  const pollClip = (jobId: string, cardId: string) => {
    const attempt = async () => {
      try {
        console.log(`[clip] polling  jobId=${jobId}  card=${cardId}`);
        const r = await fetch(`/api/motion-clip/${jobId}`);
        if (!r.ok) {
          const text = await r.text().catch(() => '');
          throw new Error(`poll HTTP ${r.status}: ${text.slice(0, 300)}`);
        }
        const d = await r.json();
        console.log(`[clip] poll response  jobId=${jobId}  status=${d.status}`, d.error ? `error=${d.error}` : d.clipUrl ? `clipUrl=${d.clipUrl}` : '');
        if (d.status === 'done') {
          console.log(`[clip] done  card=${cardId}  clipUrl=${d.clipUrl}`);
          setClips(prev => ({ ...prev, [cardId]: { status: 'done', jobId, clipUrl: d.clipUrl } }));
        } else if (d.status === 'error') {
          console.error(`[clip] job error  jobId=${jobId}  reason=${d.error}`);
          setClips(prev => ({ ...prev, [cardId]: { status: 'error', jobId, errorMsg: d.error || 'Veo job failed' } }));
        } else {
          console.log(`[clip] still pending  jobId=${jobId}  retrying in 10s`);
          setTimeout(attempt, 10_000);
        }
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        console.error('[clip] poll failed:', msg);
        setClips(prev => ({ ...prev, [cardId]: { status: 'error', jobId, errorMsg: msg } }));
      }
    };
    attempt();
  };

  const generateClip = async (cardId: string, imageUrl: string) => {
    // Guard: skip if already in-flight or finished
    if (clips[cardId]?.status === 'pending' || clips[cardId]?.status === 'done') return;
    console.log(`[clip] generate started  card=${cardId}  imageUrl=${imageUrl}`);
    setClips(prev => ({ ...prev, [cardId]: { status: 'pending' } }));
    try {
      const payload = { imageUrl, turnId: cardId };
      console.log('[clip] POST /api/motion-clip', payload);
      const r = await fetch('/api/motion-clip', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        const msg = `HTTP ${r.status}: ${text.slice(0, 300)}`;
        console.error('[clip] POST failed:', msg);
        throw new Error(msg);
      }
      const d = await r.json();
      console.log('[clip] POST response:', d);
      if (d.error) throw new Error(d.error);
      console.log(`[clip] enqueued  jobId=${d.jobId}  card=${cardId}`);
      setClips(prev => ({ ...prev, [cardId]: { status: 'pending', jobId: d.jobId } }));
      pollClip(d.jobId, cardId);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[clip] generate failed:', msg);
      setClips(prev => ({ ...prev, [cardId]: { status: 'error', errorMsg: msg } }));
    }
  };
  // ─────────────────────────────────────────────────────────────────────────

  const applyPan = useCallback((x: number, y: number, animate = false) => {
    panRef.current = { x, y };
    if (worldRef.current) {
      worldRef.current.style.transition = animate ? 'transform 0.38s cubic-bezier(0.4,0,0.2,1)' : 'none';
      worldRef.current.style.transform = `translate(${x}px, ${y}px)`;
    }
  }, []);

  const panToEl = useCallback((el: HTMLElement | null) => {
    if (!el || !storyboardRef.current) return;
    const canvasRect = storyboardRef.current.getBoundingClientRect();
    const elRect = el.getBoundingClientRect();
    const availLeft = 0;
    const availRight = 440;
    const cx = canvasRect.left + availLeft + (canvasRect.width - availLeft - availRight) / 2;
    const cy = canvasRect.top + canvasRect.height * 0.45;
    applyPan(
      panRef.current.x + (cx - (elRect.left + elRect.width / 2)),
      panRef.current.y + (cy - (elRect.top + elRect.height / 2)),
      true
    );
  }, [applyPan]);

  const refocus = useCallback(() => {
    if (!gameState?.storyboard?.length) return;
    const lastCard = gameState.storyboard[gameState.storyboard.length - 1];
    setFocusedCardId(lastCard.id);
    panToEl(cardRefs.current[lastCard.id] ?? null);
  }, [gameState?.storyboard, panToEl]); // eslint-disable-line react-hooks/exhaustive-deps

  // Pan to newly generated card when storyboard grows
  useEffect(() => {
    const len = gameState?.storyboard?.length ?? 0;
    if (len > prevStoryLenRef.current && len > 0) {
      const lastCard = gameState!.storyboard[len - 1];
      setFocusedCardId(lastCard.id);
      setTimeout(() => panToEl(cardRefs.current[lastCard.id] ?? null), 80);
    }
    prevStoryLenRef.current = len;
  }, [gameState?.storyboard?.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // When generation starts, pan to the generating placeholder (next to last card)
  useEffect(() => {
    if (isGenerating) {
      setTimeout(() => panToEl(generatingRef.current), 60);
    }
  }, [isGenerating]); // eslint-disable-line react-hooks/exhaustive-deps

  // Non-passive wheel listener for trackpad pan + regular mouse scroll wheel
  useEffect(() => {
    const el = storyboardRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey) return; // let pinch-zoom pass through
      e.preventDefault();
      // Normalize across deltaMode:
      //   0 = PIXEL (trackpad / Apple mouse) — use as-is
      //   1 = LINE  (standard scroll wheel)  — multiply by line height
      //   2 = PAGE                           — multiply by viewport height
      const lineSize = 60;
      const pageSize = el.clientHeight || 600;
      const scale = e.deltaMode === 1 ? lineSize : e.deltaMode === 2 ? pageSize : 1;
      applyPan(panRef.current.x - e.deltaX * scale, panRef.current.y - e.deltaY * scale);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [applyPan]);

  useEffect(() => {
    if (inspirations.length === 0) return;
    const timer = setInterval(() => {
      setInspirationIdx(i => (i + 1) % inspirations.length);
    }, 3000);
    return () => clearInterval(timer);
  }, [inspirations]);

  const story = gameState ? storyPacks.find(s => s.id === gameState.storyId) : undefined;
  const you = story ? (playerId === 'A' ? story.playerA : story.playerB) : undefined;


  const isMyTurn = gameState?.currentPlayer === playerId && !gameState?.isGameOver;

  // Generate hook when it becomes my turn
  useEffect(() => {
    if (isMyTurn && gameState && !gameState.currentHook && !isGenerating && !gameState.isGameOver) {
      const history = gameState.storyboard.map(c => `Turn ${c.turn} (${c.player}): ${c.text}`).join('\n\n');
      import('./server/gemini').then(m => m.generateHook(history, story?.anchors || [])).then(hook => {
        if (hook) {
          updateGameState(prev => ({ ...prev, currentHook: hook }));
        }
      });
    }
  }, [isMyTurn, gameState?.currentHook, isGenerating, gameState?.isGameOver, gameState?.storyboard, story?.anchors, updateGameState]);

  // Generate character canon once per story (before early returns to satisfy Rules of Hooks)
  useEffect(() => {
    if (!story) return;
    characterCanonApi({
      characterIdentityLock: story.characterIdentityLock,
      playerAName: story.playerA.defaultName,
      playerBName: story.playerB.defaultName,
    }).then(canon => {
      castTableRef.current = buildCastTable(canon, story.playerA.defaultName, story.playerB.defaultName);
    });
  }, [story?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Show ending frame first, then outcome modal when game ends
  useEffect(() => {
    if (gameState?.isGameOver) setShowEndingFrame(true);
  }, [gameState?.isGameOver]);

  // Timer effects must live here (before early returns) to satisfy Rules of Hooks
  useEffect(() => {
    if (isMyTurn && !gameState?.isGameOver) setTimeLeft(TURN_SECONDS);
  }, [gameState?.currentTurn, gameState?.currentPlayer]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!isMyTurn || isGenerating || gameState?.isGameOver) return;
    if (timeLeft <= 0) { handleAutoSubmitRef.current(); return; }
    const t = setTimeout(() => setTimeLeft(s => s - 1), 1000);
    return () => clearTimeout(t);
  }, [timeLeft, isMyTurn, isGenerating, gameState?.isGameOver]); // eslint-disable-line react-hooks/exhaustive-deps

  if (loading) {
    return <div className="h-screen w-full bg-[#0a0806] flex items-center justify-center text-[#8a6331]">Loading...</div>;
  }

  if (error || !gameState) {
    return (
      <div className="h-screen w-full bg-[#0a0806] text-[#f4ebd8] flex flex-col items-center justify-center p-8 relative">
        <div className="absolute inset-0 pointer-events-none opacity-50 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E")` }}></div>
        <div className="max-w-md w-full bg-[#1a110c] border border-[#8a6331]/30 rounded-sm p-8 shadow-2xl text-center relative z-10">
          <AlertTriangle className="w-12 h-12 text-[#d1a561] mx-auto mb-4" />
          <h2 className="text-xl font-bold mb-2 text-[#d1a561]">Unable to Enter Duel</h2>
          <p className="text-[#a87b38] mb-8 text-sm">{error || 'Session data not found.'}</p>
          <button 
            onClick={() => { window.location.href = '/'; }}
            className="w-full py-3 bg-[#2c1e16] text-[#f4ebd8] text-xs font-bold rounded-sm shadow-md hover:bg-[#3d2a1f] transition-all tracking-[0.2em] uppercase border border-[#8a6331]/50"
          >
            Return to Story Shelf
          </button>
        </div>
      </div>
    );
  }

  if (!story || !you) return <div className="h-screen w-full bg-[#0a0806] flex items-center justify-center text-red-500">Story data not found.</div>;

  const opponent = playerId === 'A' ? story.playerB : story.playerA;
  const opponentId = playerId === 'A' ? 'B' : 'A';

  const opponentSideQuestRevealed = gameState.storyboard.some(card => card.player === opponentId && card.bonus);
  const finalCard = gameState.storyboard[gameState.storyboard.length - 1];
  const finalImageUrl = finalCard?.panels?.[0]?.imageUrl ?? '';
  const finalText = finalCard?.text ?? '';

  const composeIntentText = (bodyOverride?: string) => {
    if (!you) return '';
    const goalText = intentGoalType === 'main' ? you.goal : you.sideQuest;
    const body = bodyOverride !== undefined ? bodyOverride : intentBody;
    return `// === Goal ===\n${goalText}\n\n// === Tone ===\nTone: ${intentTone}\n\n${body}`;
  };

  const handleGetInspirations = async () => {
    if (!isMyTurn || loadingInspirations) return;
    setLoadingInspirations(true);
    setInspirations([]);
    setInspirationIdx(0);
    const history = gameState.storyboard.map(c => `Turn ${c.turn} (${c.player}): ${c.text}`).join('\n\n');
    const anchors = story?.anchors || [];
    const existing = gameState.currentHook;
    const newHooks = await Promise.all([
      import('./server/gemini').then(m => m.generateHook(history, anchors)),
      import('./server/gemini').then(m => m.generateHook(history, anchors)),
    ]);
    const all = [existing, ...newHooks].filter(Boolean) as string[];
    setInspirations(all.slice(0, 3));
    setLoadingInspirations(false);
  };

  /** Simple post-processing for speech transcript. Extend SPEECH_CORRECTIONS for product terms. */
  const SPEECH_CORRECTIONS: Record<string, string> = {
    'player a': 'Player A',
    'player b': 'Player B',
    'ending a': 'Ending A',
    'ending b': 'Ending B',
  };
  const postProcessSpeech = (text: string): string => {
    let r = text.trim();
    if (!r) return r;
    r = r.charAt(0).toUpperCase() + r.slice(1);
    for (const [from, to] of Object.entries(SPEECH_CORRECTIONS)) {
      r = r.replace(new RegExp(`\\b${from}\\b`, 'gi'), to);
    }
    return r;
  };

  const handleVoice = async () => {
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SR) return;
    if (isVoiceActive) {
      recRef.current?.stop();
      setIsVoiceActive(false);
      setVoiceInterim('');
      return;
    }

    // Pre-request mic with optimized audio constraints (best-effort; helps Chrome pick up settings)
    try {
      await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
    } catch { /* recognition will request its own permission */ }

    setIsVoiceActive(true);
    setVoiceInterim('');

    const rec = new SR();
    rec.lang = 'en-US';         // fixed English — no OS auto-detect
    rec.continuous = false;     // single-utterance: auto-stops after natural pause
    rec.interimResults = true;  // show partial results while speaking
    rec.maxAlternatives = 1;
    recRef.current = rec;

    rec.onstart = () => {
      console.log('[Voice] recognition started — lang:', rec.lang, 'continuous:', rec.continuous);
    };

    rec.onresult = (e: any) => {
      let finalText = '';
      let interimText = '';
      // Only process results from resultIndex forward — avoids re-processing past results
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const chunk = e.results[i][0].transcript;
        if (e.results[i].isFinal) finalText += chunk;
        else interimText += chunk;
      }
      if (interimText) {
        console.log('[Voice] interim:', interimText);
        setVoiceInterim(interimText);
      }
      if (finalText) {
        const processed = postProcessSpeech(finalText);
        console.log('[Voice] final committed — raw:', JSON.stringify(finalText), '→ processed:', JSON.stringify(processed));
        setIntentBody(p => p + (p && !p.endsWith('\n') ? '\n' : '') + processed);
        setVoiceInterim('');
      }
    };

    rec.onerror = (e: any) => {
      console.warn('[Voice] error — code:', e.error);
      setIsVoiceActive(false);
      setVoiceInterim('');
    };
    rec.onend = () => {
      console.log('[Voice] recognition ended');
      setIsVoiceActive(false);
      setVoiceInterim('');
    };

    rec.start();
  };

  const handleGenerate = async (bodyOverride?: string) => {
    if (!isMyTurn) return;
    setIsGenerating(true);

    const composed = composeIntentText(bodyOverride);
    const history = gameState.storyboard.map(c => `Turn ${c.turn} (${c.player}): ${c.text}`).join('\n\n');

    // Step 1: Generate scene text + image prompt via server
    const { textResult, imagePrompt: serverImagePrompt, usedTextModel, textError } = await generateTurnTextApi({
      history, playerId, intentText: composed, progressA: gameState.progressA,
      characterLock: story.characterIdentityLock, styleLock: story.visualStyleLock,
      credibility: gameState.credibility, evidenceState: gameState.evidenceState,
      mediaState: gameState.mediaState, trustState: gameState.trustState, anchors: story.anchors,
      sideQuestAlreadyEarned: gameState.sideQuestEarned[playerId],
      currentTurn: gameState.currentTurn,
      // Code-level guard: intentScale is 'FINAL' only when both conditions are true.
      // Turn 10 without amplified/lock phase gets 'NORMAL' — model never sees FINAL.
      intentScale: (gameState.currentTurn === 10 &&
        (gameState.outcome.phase === 'amplified' || gameState.outcome.phase === 'lock'))
        ? 'FINAL' : 'NORMAL',
      castTable: castTableRef.current,
    });

    // Step 2: Show card immediately with text, panels empty
    const cardId = `turn-${gameState.currentTurn}`;
    const partial: TurnData = {
      id: cardId, turn: gameState.currentTurn, player: playerId,
      text: textResult.sceneText, panels: [],
      inapplicable: textResult.inapplicableIntent || [],
      inapplicableReason: textResult.inapplicableReason,
      bonus: !gameState.sideQuestEarned[playerId] && (textResult.bonusAwarded || false),
    };
    setInProgressCard(partial);

    // ── [IMAGE DEBUG] ────────────────────────────────────────────────────────
    console.group(`[IMAGE DEBUG] Turn ${partial.turn}`);
    console.log('[IMAGE DEBUG] raw sceneText\n', textResult.sceneText);
    console.log('[IMAGE DEBUG] final imagePrompt\n', serverImagePrompt);
    console.groupEnd();
    // ─────────────────────────────────────────────────────────────────────────

    const panels: Panel[] = [];
    let lastImageError: string | null = null;
    let lastImageModel = 'placeholder';

    {
      const { imageUrl, usedImageModel, imageError, imageFailed } = await generateImageApi(serverImagePrompt);
      const panel: Panel = {
        imageUrl: imageFailed ? `https://picsum.photos/seed/${encodeURIComponent(textResult.sceneText.slice(0, 40))}/400/300?grayscale` : imageUrl,
        caption: textResult.sceneText,
        failed: imageFailed,
      };
      panels.push(panel);
      setInProgressCard(prev => prev ? { ...prev, panels: [...panels] } : null);
      if (imageError) lastImageError = imageError;
      if (usedImageModel !== 'placeholder') lastImageModel = usedImageModel;
    }

    // Step 4: Commit to shared game state, clear in-progress
    const finalCard: TurnData = { ...partial, panels };
    setInProgressCard(null);

    // ── Outcome engine snapshot (pre-computed for debug; updateGameState re-derives
    //    from prev to stay correct under concurrent updates) ──────────────────────
    const _prevProgressA = gameState.progressA;
    const _prevOutcome   = gameState.outcome;
    const _bonusEligible =
      !gameState.sideQuestEarned[playerId] &&
      gameState.currentTurn >= 3 &&
      (textResult.bonusAwarded ?? false);
    const _impact = buildTurnImpact(
      playerId, _prevProgressA, textResult.endingAProgress,
      textResult.inapplicableIntent ?? [], textResult.credibilityDelta ?? 0,
      _bonusEligible, _bonusEligible ? (textResult.bonusAmount ?? 0) : 0,
    );
    const { progressA: _engineProgressA, outcome: _newOutcome } = applyTurnImpact(
      { progressA: _prevProgressA, outcome: _prevOutcome }, _impact,
    );

    // Improved console log — before/after for every field that matters
    console.group(`[OutcomeEngine] Turn ${gameState.currentTurn} · Player ${playerId}`);
    console.log(`  prevProgressA   ${_prevProgressA.toFixed(1)}`);
    console.log(`  GM raw target   ${textResult.endingAProgress}`);
    console.log(`  baseDelta       ${_impact.baseDelta.toFixed(1)}  causal=${_impact.isCausallySupported}  bonus=${_bonusEligible}(+${_impact.bonusAmount})`);
    console.log(`  momentum        ${_prevOutcome.momentum} → ${_newOutcome.momentum}`);
    console.log(`  phase           ${_prevOutcome.phase} → ${_newOutcome.phase}`);
    console.log(`  streak          ${_prevOutcome.streakPlayer ?? 'null'}×${_prevOutcome.streakCount} → ${_newOutcome.streakPlayer ?? 'null'}×${_newOutcome.streakCount}`);
    console.log(`  engineProgressA ${_engineProgressA.toFixed(1)}`);
    console.groupEnd();
    // ────────────────────────────────────────────────────────────────────────────

    updateGameState(prev => {
      const nextPlayer = prev.currentPlayer === 'A' ? 'B' : 'A';
      const isGameOver = prev.currentTurn >= 10;

      // Side quest can only be earned once per player per match, and not before turn 3.
      const bonusEligible =
        !prev.sideQuestEarned[playerId] &&
        prev.currentTurn >= 3 &&
        (textResult.bonusAwarded ?? false);

      // Build TurnImpact from GM result and apply the Outcome Engine
      const impact = buildTurnImpact(
        playerId,
        prev.progressA,
        textResult.endingAProgress,
        textResult.inapplicableIntent ?? [],
        textResult.credibilityDelta ?? 0,
        bonusEligible,
        bonusEligible ? (textResult.bonusAmount ?? 0) : 0,
      );
      const { progressA: newProgressA, outcome: newOutcome } = applyTurnImpact(
        { progressA: prev.progressA, outcome: prev.outcome },
        impact,
      );

      return {
        ...prev,
        storyboard: [...prev.storyboard, finalCard],
        progressA: newProgressA,
        outcome: newOutcome,
        sideQuestEarned: bonusEligible
          ? { ...prev.sideQuestEarned, [playerId]: true }
          : prev.sideQuestEarned,
        credibility: Math.max(0, Math.min(100, prev.credibility + (textResult.credibilityDelta || 0))),
        evidenceState: textResult.newEvidenceState || prev.evidenceState,
        mediaState: textResult.newMediaState || prev.mediaState,
        trustState: textResult.newTrustState || prev.trustState,
        currentHook: '',
        currentPlayer: nextPlayer,
        currentTurn: isGameOver ? prev.currentTurn : prev.currentTurn + 1,
        isGameOver,
        lastIntentByPlayer: {
          ...prev.lastIntentByPlayer,
          [playerId]: { turnIndex: prev.currentTurn, intentMdText: composed },
          [opponentId]: undefined,
        },
      };
    });

    setDebugInfo({
      textModel: usedTextModel,
      imageModel: lastImageModel,
      lastError: [textError, lastImageError].filter(Boolean).join(' | ') || null,
      show: false,
      outcome: {
        turn:               gameState.currentTurn,
        player:             playerId,
        prevProgressA:      _prevProgressA,
        gmRawTarget:        textResult.endingAProgress,
        engineProgressA:    _engineProgressA,
        baseDelta:          _impact.baseDelta,
        isCausallySupported: _impact.isCausallySupported,
        bonusAwarded:       _bonusEligible,
        bonusAmount:        _impact.bonusAmount,
        prevMomentum:       _prevOutcome.momentum,
        newMomentum:        _newOutcome.momentum,
        prevPhase:          _prevOutcome.phase,
        newPhase:           _newOutcome.phase,
        streakPlayer:       _newOutcome.streakPlayer,
        streakCount:        _newOutcome.streakCount,
      },
    });
    setIsGenerating(false);
    // Auto-start motion clip as soon as image is committed
    if (!panels[0]?.failed && panels[0]?.imageUrl) {
      generateClip(finalCard.id, panels[0].imageUrl);
    }
    setIntentBody('// Scene Direction\n\n\n// Constraints\n\n\n// Rules\n');
  };

  const handleAutoSubmit = async () => {
    const hasContent = intentBody.split('\n').some(line => {
      const t = line.trim();
      return t.length > 0 && !t.startsWith('//');
    });
    if (hasContent) {
      handleGenerate();
    } else {
      // Fetch a random inspiration and use it as the body
      const history = gameState.storyboard.map(c => `Turn ${c.turn} (${c.player}): ${c.text}`).join('\n\n');
      const anchors = story?.anchors || [];
      const hooks = await Promise.all([
        import('./server/gemini').then(m => m.generateHook(history, anchors)),
        import('./server/gemini').then(m => m.generateHook(history, anchors)),
      ]);
      const valid = hooks.filter(Boolean) as string[];
      const picked = valid.length > 0 ? valid[Math.floor(Math.random() * valid.length)] : 'Continue the story.';
      const autoBody = INTENT_TEMPLATE.trimEnd() + '\n' + picked;
      setIntentBody(autoBody);
      handleGenerate(autoBody);
    }
  };

  // Sync the auto-submit ref so the countdown effect always calls the latest version
  handleAutoSubmitRef.current = handleAutoSubmit;

  return (
    <div className="h-screen w-full bg-[#0a0806] text-[#f4ebd8] flex flex-col overflow-hidden font-sans">
      {/* Briefing Overlay */}
      <AnimatePresence>
        {showBriefing && (
          <motion.div
            initial={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-[#0a0806]/80 backdrop-blur-sm flex flex-col items-center justify-center p-8"
          >
            <div className="max-w-2xl w-full bg-[#f4ebd8] border border-[#8a6331]/30 rounded-sm p-10 shadow-2xl relative text-[#2c1e16]">
              {/* Decorative Border */}
              <div className="absolute inset-4 border border-[#8a6331]/20 pointer-events-none rounded-sm" />
              <div className="absolute inset-5 border border-[#8a6331]/10 pointer-events-none rounded-sm" />

              <h1 className="text-3xl font-bold mb-6 text-center">Story Briefing</h1>
              <div className="flex items-center gap-4 mb-8 justify-center">
                <div className="w-14 h-14 rounded-full bg-[#ffeedd]/30 flex items-center justify-center border border-[#8a6331]/30 shadow-inner shrink-0">
                  <PlayerAvatar playerId={playerId} size="lg" />
                </div>
                <div>
                  <div className="text-xl font-bold">{playerId === 'A' ? gameState.playerAName : gameState.playerBName}</div>
                  <div className="text-xs text-[#8a6331] uppercase tracking-widest font-bold">Player {playerId}</div>
                </div>
              </div>

              <div className="mb-8 relative z-10 space-y-5">
                <div>
                  <h3 className="text-xs font-bold text-[#8a6331] mb-2 uppercase tracking-widest">Narrative Goal</h3>
                  <p className="text-[#2c1e16] leading-relaxed">{you.goal}</p>
                </div>
                <div className="w-full h-px bg-[#8a6331]/20" />
                <div>
                  <h3 className="text-xs font-bold text-[#8a6331] mb-2 uppercase tracking-widest flex items-center gap-1.5">
                    <EyeOff className="w-3 h-3" /> Hidden Story Thread
                  </h3>
                  <p className="text-[#2c1e16] leading-relaxed">{you.sideQuestHint}</p>
                </div>
              </div>

              <button
                onClick={() => setShowBriefing(false)}
                className="w-full py-3 bg-[#2c1e16] text-[#f4ebd8] text-xs font-bold rounded-sm shadow-md hover:bg-[#1a110c] transition-all tracking-[0.2em] uppercase border border-[#4a3320] relative z-10"
              >
                Acknowledge & Begin
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top Bar */}
      <header className="h-16 border-b border-[#8a6331]/20 flex items-center justify-between px-6 shrink-0 bg-[#1a110c] relative z-10 shadow-md">
        <div className="flex items-center gap-4 w-1/4">
          <h1 className="font-bold text-lg tracking-tight truncate text-[#d1a561]">{story.title}</h1>
        </div>
        
        {/* Progress Bar (Center, Larger) */}
        <div className="flex-1 max-w-2xl flex flex-col items-center justify-center px-8">
          <div className="flex justify-between w-full text-xs font-bold mb-1 uppercase tracking-wider">
            <span className="text-[#8a6331]">Ending A ({parseFloat(gameState.progressA.toFixed(1))}%)</span>
            <span className="text-[#a87b38] flex items-center gap-2">
              Turn {gameState.currentTurn} / 10
              {gameState.storyboard.length > 0 && gameState.storyboard[gameState.storyboard.length - 1].bonus && (
                <span className="flex items-center gap-1 text-[#6abf72] animate-[fade-in_0.4s_ease-out_forwards]">
                  <Zap className="w-3 h-3" />
                  <span className="text-[9px] tracking-widest">+BONUS</span>
                </span>
              )}
            </span>
            <span className="text-[#8a6331]">Ending B ({parseFloat((100 - gameState.progressA).toFixed(1))}%)</span>
          </div>
          <div className="w-full h-2 bg-[#0a0806] rounded-sm overflow-hidden flex shadow-inner border border-[#4a3320]">
            <div className="h-full bg-[#d1a561] transition-all duration-500" style={{ width: `${gameState.progressA}%` }} />
            <div className="h-full bg-[#8a6331] transition-all duration-500" style={{ width: `${100 - gameState.progressA}%` }} />
          </div>
        </div>

        <div className="w-1/4 flex justify-end items-center gap-4">
          {/* Temporary translation toggle */}
          <button
            disabled={isTranslating}
            onClick={async () => {
              if (showTranslation) { setShowTranslation(false); return; }
              const texts = gameState.storyboard.map(c => c.text).filter((t): t is string => !!t && t.trim().length > 0);
              if (texts.length === 0) { setShowTranslation(true); return; }
              // Only translate texts not yet cached
              const missing = texts.filter(t => !translatedTexts[t]);
              if (missing.length === 0) { setShowTranslation(true); return; }
              setIsTranslating(true);
              let ok = false;
              try {
                const map = await translateApi(missing);
                if (Object.keys(map).length > 0) {
                  setTranslatedTexts(prev => ({ ...prev, ...map }));
                  ok = true;
                }
              } catch (e) {
                console.warn('[translate] failed:', e);
              }
              setIsTranslating(false);
              if (ok) setShowTranslation(true);
            }}
            className="text-[#8a6331] hover:text-[#d1a561] text-xs uppercase tracking-widest font-bold transition-colors disabled:opacity-40"
          >
            {isTranslating ? '翻译中…' : showTranslation ? '原文' : '译文'}
          </button>
          <button onClick={() => window.location.hash = ''} className="text-[#8a6331] hover:text-[#d1a561] text-xs uppercase tracking-widest font-bold transition-colors">
            Exit Session
          </button>
        </div>
      </header>

      {/* Main Content — canvas as base layer, panels as floating overlays */}
      <main className="flex-1 relative overflow-hidden bg-[#0a0806]">

        {/* ── Infinite Canvas (full-screen base layer) ── */}
        <section
          ref={storyboardRef}
          tabIndex={0}
          className="absolute inset-0 overflow-hidden outline-none"
          style={{
            backgroundColor: '#080604',
            backgroundImage: 'radial-gradient(circle, #2a1a0e 1px, transparent 1px)',
            backgroundSize: '24px 24px',
            cursor: isDragging ? 'grabbing' : spaceReady ? 'grab' : 'default',
          }}
          onMouseDown={(e) => {
            const isRightDrag = e.button === 2;
            const isSpaceDrag = e.button === 0 && isSpaceDownRef.current;
            if (!isRightDrag && !isSpaceDrag) return;
            e.preventDefault();
            dragStartRef.current = { mouseX: e.clientX, mouseY: e.clientY, panX: panRef.current.x, panY: panRef.current.y };
            setIsDragging(true);
          }}
          onMouseMove={(e) => {
            if (!dragStartRef.current) return;
            applyPan(
              dragStartRef.current.panX + (e.clientX - dragStartRef.current.mouseX),
              dragStartRef.current.panY + (e.clientY - dragStartRef.current.mouseY),
            );
          }}
          onMouseUp={() => { dragStartRef.current = null; setIsDragging(false); }}
          onMouseLeave={() => { dragStartRef.current = null; setIsDragging(false); }}
          onContextMenu={(e) => e.preventDefault()}
          onKeyDown={(e) => {
            if (e.code === 'Space') { e.preventDefault(); isSpaceDownRef.current = true; setSpaceReady(true); return; }
            const step = 220;
            if (e.key === 'ArrowRight') applyPan(panRef.current.x - step, panRef.current.y, true);
            else if (e.key === 'ArrowLeft') applyPan(panRef.current.x + step, panRef.current.y, true);
            else if (e.key === 'ArrowDown') applyPan(panRef.current.x, panRef.current.y - step, true);
            else if (e.key === 'ArrowUp') applyPan(panRef.current.x, panRef.current.y + step, true);
          }}
          onKeyUp={(e) => {
            if (e.code === 'Space') { isSpaceDownRef.current = false; setSpaceReady(false); }
          }}
        >
          {/* World — only this div gets the pan transform */}
          <div ref={worldRef} style={{ transform: 'translate(0px, 0px)', willChange: 'transform', position: 'absolute', top: 0, left: 0 }}>
          {(() => {
            // Same width for every frame; height varies per turn via aspect ratio
            const FRAME_W = 480;
            // Sprocket hole strip
            const Sprockets = ({ count }: { count: number }) => (
              <div style={{ display: 'flex', alignItems: 'center', background: '#060402', padding: '5px 6px', gap: 10 }}>
                {Array.from({ length: count }).map((_, i) => (
                  <div key={i} style={{ width: 16, height: 10, borderRadius: 2, background: '#020100', border: '1px solid #181008', flexShrink: 0 }} />
                ))}
              </div>
            );
            return (
          <div className="pt-14 pb-56 space-y-14 min-w-max" style={{ paddingLeft: 400, paddingRight: 500 }}>
            {[...gameState.storyboard, ...(inProgressCard ? [inProgressCard] : [])].map((card, cardIdx) => {
              const isLive = inProgressCard !== null && card.id === inProgressCard.id;
              const panels = card.panels && card.panels.length > 0 ? card.panels : null;
              const accentColor = card.turn === 0 ? '#8a6331' : card.player === 'A' ? '#d1a561' : '#8a6331';
              const isFocused = focusedCardId === null || card.id === focusedCardId;
              const panelCount = (panels ? panels.length : 0) + (isLive ? 1 : 0) || 1;
              const stripInnerW = FRAME_W * panelCount + 2 * (panelCount - 1) + 8;
              const holeCount = Math.max(6, Math.floor(stripInnerW / 28));
              return (
                <motion.div
                  key={card.id}
                  ref={(el: HTMLDivElement | null) => {
                    cardRefs.current[card.id] = el;
                    if (isLive) { (generatingRef as { current: HTMLDivElement | null }).current = el; }
                  }}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: isFocused ? 1 : 0.18, y: 0 }}
                  transition={{ duration: 0.4 }}
                  onClick={() => { setFocusedCardId(card.id); panToEl(cardRefs.current[card.id] ?? null); }}
                  style={{ cursor: isFocused ? 'default' : 'pointer' }}
                >
                  {/* Sequence label — clapperboard style */}
                  <div className="flex items-center gap-2 mb-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em]" style={{ color: accentColor }}>
                      {card.turn === 0 ? '▪ Prologue' : `▪ Scene ${String(card.turn).padStart(2, '0')} · Player ${card.player}`}
                      {isLive && <span style={{ color: '#4a3320', marginLeft: 8 }}>· rendering…</span>}
                    </span>
                  </div>

                  {(panels || isLive) ? (
                    /* ── Film frame + story text side by side ── */
                    <div style={{ display: 'flex', gap: 24, alignItems: 'flex-start' }}>
                      {/* Left: film strip */}
                      <div style={{
                        display: 'inline-flex', flexDirection: 'column', flexShrink: 0,
                        background: '#0c0a07',
                        boxShadow: isFocused
                          ? `0 0 0 1px #2a1a0e, 0 16px 60px rgba(0,0,0,0.9), 0 0 40px ${accentColor}12`
                          : '0 4px 20px rgba(0,0,0,0.5)',
                        transition: 'box-shadow 0.4s',
                      }}>
                        <Sprockets count={holeCount} />
                        <div style={{ padding: '0 4px' }}>
                          {panels && panels.length > 0 ? (
                            <div ref={lastRowRef}
                              style={{ width: FRAME_W, position: 'relative', background: '#080604', overflow: 'hidden' }}
                              className="group/frame"
                              onMouseEnter={() => {
                                if (clips[card.id]?.status === 'done' && !hintDismissed[card.id]) {
                                  setHintDismissed(prev => ({ ...prev, [card.id]: true }));
                                }
                              }}>
                              {hasMediaSrc(panels[0].imageUrl) && (() => {
                                const frameClip = clips[card.id];
                                const hasClip = frameClip?.status === 'done' && frameClip.clipUrl;
                                return (
                                  <>
                                    <img
                                      src={panels[0].imageUrl}
                                      alt="Frame"
                                      style={{ width: '100%', height: 'auto', display: 'block',
                                        transition: 'transform 6s cubic-bezier(0.25, 0.46, 0.45, 0.94), opacity 0.3s',
                                        transformOrigin: 'center center',
                                      }}
                                      className={`sepia-[0.10] group-hover/frame:scale-110${hasClip ? ' group-hover/frame:opacity-0' : ''}`}
                                      referrerPolicy="no-referrer"
                                      onMouseEnter={e => {
                                        const origins = ['30% 30%', '70% 30%', '50% 70%', '30% 70%', '70% 60%'];
                                        e.currentTarget.style.transformOrigin = origins[Math.floor(Math.random() * origins.length)];
                                      }}
                                    />
                                    {hasClip && (
                                      <video
                                        src={frameClip.clipUrl}
                                        autoPlay loop muted playsInline
                                        style={{
                                          position: 'absolute', inset: 0,
                                          width: '100%', height: '100%',
                                          objectFit: 'cover',
                                          opacity: 0,
                                          transition: 'opacity 0.3s',
                                        }}
                                        className="group-hover/frame:!opacity-100"
                                      />
                                    )}
                                    {hasClip && !hintDismissed[card.id] && (
                                      <div style={{
                                        position: 'absolute', bottom: 8, right: 8,
                                        fontFamily: 'monospace', fontSize: 8,
                                        color: 'rgba(255,255,255,0.5)',
                                        letterSpacing: '0.1em',
                                        textTransform: 'uppercase',
                                        pointerEvents: 'none',
                                        background: 'rgba(0,0,0,0.4)',
                                        padding: '2px 5px',
                                      }}>
                                        hover to play
                                      </div>
                                    )}
                                  </>
                                );
                              })()}
                              {/* Cinematic vignette on hover */}
                              <div style={{
                                position: 'absolute', inset: 0, pointerEvents: 'none',
                                background: 'radial-gradient(ellipse at center, transparent 55%, rgba(0,0,0,0.55) 100%)',
                                opacity: 0, transition: 'opacity 0.4s',
                              }} className="group-hover/frame:!opacity-100" />
                              <span style={{
                                position: 'absolute', bottom: 6, left: 8,
                                fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.22)',
                                letterSpacing: '0.1em', pointerEvents: 'none',
                              }}>
                                {String(cardIdx * 10 + 1).padStart(3, '0')}
                              </span>
                              {panels[0].failed && (
                                <div className="absolute inset-0 bg-black/80 flex items-center justify-center">
                                  <span style={{ fontSize: 9, fontFamily: 'monospace', color: '#f4ebd8', background: '#2c1e16', padding: '2px 8px', border: '1px solid #8a633150', textTransform: 'uppercase', letterSpacing: '0.12em' }}>Failed</span>
                                </div>
                              )}
                            </div>
                          ) : (
                            /* Spinner while image generates */
                            <div style={{ width: FRAME_W, aspectRatio: '4/3', background: '#0c0a07',
                              display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 10 }}>
                              <div className="w-4 h-4 border-2 border-[#2a1a0e] border-t-[#8a6331] rounded-full animate-spin" />
                              <span style={{ fontFamily: 'monospace', fontSize: 9, color: 'rgba(255,255,255,0.18)', letterSpacing: '0.12em', textTransform: 'uppercase' }}>rendering…</span>
                            </div>
                          )}
                        </div>
                        <Sprockets count={holeCount} />
                      </div>

                      {/* Right: story text, sentence by sentence */}
                      {(() => {
                        const displayText = (showTranslation && card.text && translatedTexts[card.text]) ? translatedTexts[card.text] : card.text;
                        const sentences = displayText
                          ? (displayText.match(/[^.!?！？。]+[.!?！？。]+/g) || [displayText]).map((s: string) => s.trim()).filter((s: string) => s)
                          : [];
                        return (
                          <div style={{ width: 300, paddingTop: 6 }}>
                            {sentences.map((sentence: string, si: number) => (
                              <p key={`${card.id}-${showTranslation ? 'zh' : 'en'}-${si}`} style={{
                                fontSize: 14, color: '#e8d5b0', lineHeight: 1.75, marginBottom: 10,
                                opacity: 0,
                                animation: 'fade-in 0.5s ease-out forwards',
                                animationDelay: `${si * 0.25}s`,
                              }}>
                                {sentence}
                              </p>
                            ))}
                            {/* Skeleton while text not yet available */}
                            {sentences.length === 0 && isLive && (
                              <>
                                <div style={{ height: 14, background: '#1a1008', borderRadius: 2, marginBottom: 8, width: '90%', animation: 'fade-in 0.3s ease-out forwards' }} />
                                <div style={{ height: 14, background: '#1a1008', borderRadius: 2, marginBottom: 8, width: '75%', animation: 'fade-in 0.3s ease-out forwards', animationDelay: '0.1s', opacity: 0 }} />
                                <div style={{ height: 14, background: '#1a1008', borderRadius: 2, width: '55%', animation: 'fade-in 0.3s ease-out forwards', animationDelay: '0.2s', opacity: 0 }} />
                              </>
                            )}
                            {/* Side Quest badge — only when bonus achieved */}
                            {card.bonus && (
                              <div className="flex items-center gap-2 mt-4 bg-[#3a7d44]/20 border border-[#6abf72]/30 px-3 py-2"
                                style={{ animation: `fade-in 0.5s ease-out forwards`, animationDelay: `${sentences.length * 0.35 + 0.2}s`, opacity: 0 }}>
                                <Zap className="w-3.5 h-3.5 text-[#6abf72] shrink-0" />
                                <span className="text-[11px] font-bold uppercase tracking-widest text-[#a8e0b0]">Side Quest Completed</span>
                              </div>
                            )}
                            {/* Inapplicable warning */}
                            {card.inapplicable && card.inapplicable.length > 0 && (
                              <div className="flex items-start gap-2 text-[#d1a561] text-xs mt-3">
                                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                                <div>
                                  <span className="font-bold uppercase tracking-wider block mb-1">Intent Partially Inapplicable:</span>
                                  <ul className="list-disc list-inside space-y-0.5 text-[#a87b38]">
                                    {card.inapplicable.map((item: string, i: number) => <li key={i}>{item}</li>)}
                                  </ul>
                                  {card.inapplicableReason && <p className="text-[#8a6331] mt-1">{card.inapplicableReason}</p>}
                                </div>
                              </div>
                            )}
                            {/* ── Motion clip status (auto-generated, no manual trigger) ── */}
                            {(() => {
                              const clip = clips[card.id];
                              if (clip?.status === 'pending') {
                                return (
                                  <div className="mt-3 flex items-center gap-2 text-[#5a4024] text-[10px] uppercase tracking-widest">
                                    <div className="w-3 h-3 border border-[#4a3320] border-t-[#8a6331] rounded-full animate-spin" />
                                    generating clip…
                                  </div>
                                );
                              }
                              if (clip?.status === 'error') {
                                const srcUrl = panels?.[0]?.imageUrl;
                                return (
                                  <div className="mt-3 flex flex-col gap-1">
                                    {clip.errorMsg && (
                                      <div className="text-[10px] text-[#8a4040] font-mono break-all leading-relaxed">
                                        {clip.errorMsg}
                                      </div>
                                    )}
                                    {srcUrl && (
                                      <button
                                        onClick={() => {
                                          setClips(prev => { const n = { ...prev }; delete n[card.id]; return n; });
                                          generateClip(card.id, srcUrl);
                                        }}
                                        className="text-[10px] text-[#8a4040] hover:text-[#d1a561] uppercase tracking-widest transition-colors text-left"
                                      >
                                        ↺ retry
                                      </button>
                                    )}
                                  </div>
                                );
                              }
                              return null;
                            })()}
                          </div>
                        );
                      })()}
                    </div>
                  ) : (
                    // Text-only card (prologue / non-image turn)
                    <div ref={lastRowRef} style={{
                      width: 560, padding: '20px 24px',
                      background: '#0c0a07',
                      border: '1px solid #1a1208',
                      boxShadow: isFocused ? '0 8px 40px rgba(0,0,0,0.8)' : '0 4px 16px rgba(0,0,0,0.5)',
                      transition: 'box-shadow 0.4s',
                    }}>
                      <p className="text-sm text-[#b8a880] leading-relaxed whitespace-pre-wrap" style={{ fontFamily: 'monospace' }}>
                        {(showTranslation && card.text && translatedTexts[card.text]) ? translatedTexts[card.text] : card.text}
                      </p>
                    </div>
                  )}
                </motion.div>
              );
            })}

            {/* Generating placeholder — film strip skeleton */}
            {isGenerating && (() => {
              const skelW = FRAME_W + 8;
              const skelHoles = Math.max(6, Math.floor(skelW / 28));
              return (
                <motion.div ref={generatingRef} initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.3 }}>
                  <div className="mb-2">
                    <span className="font-mono text-[10px] uppercase tracking-[0.22em] text-[#4a3320]">
                      ▪ Scene {String(gameState.storyboard.length).padStart(2, '0')} · Generating…
                    </span>
                  </div>
                  <div style={{ display: 'inline-flex', flexDirection: 'column', background: '#0c0a07', border: '1px dashed #2a1a0e' }}>
                    <div style={{ display: 'flex', alignItems: 'center', background: '#060402', padding: '5px 6px', gap: 10 }}>
                      {Array.from({ length: skelHoles }).map((_, i) => (
                        <div key={i} style={{ width: 16, height: 10, borderRadius: 2, background: '#020100', border: '1px solid #181008', flexShrink: 0 }} />
                      ))}
                    </div>
                    <div style={{ width: skelW, height: Math.round(skelW * 3 / 4), display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
                      <div className="w-4 h-4 border-2 border-[#2a1a0e] border-t-[#8a6331] rounded-full animate-spin" />
                      <span style={{ fontFamily: 'monospace', fontSize: 10, color: '#4a3320', textTransform: 'uppercase', letterSpacing: '0.16em' }}>Rendering frame…</span>
                    </div>
                    <div style={{ display: 'flex', alignItems: 'center', background: '#060402', padding: '5px 6px', gap: 10 }}>
                      {Array.from({ length: skelHoles }).map((_, i) => (
                        <div key={i} style={{ width: 16, height: 10, borderRadius: 2, background: '#020100', border: '1px solid #181008', flexShrink: 0 }} />
                      ))}
                    </div>
                  </div>
                </motion.div>
              );
            })()}

            {/* Awaiting placeholder */}
            {!isMyTurn && !gameState.isGameOver && !isGenerating && (
              <div style={{ fontFamily: 'monospace', fontSize: 10, color: '#4a3320', textTransform: 'uppercase', letterSpacing: '0.2em' }} className="animate-pulse">
                ▪ Awaiting opponent's move…
              </div>
            )}
          </div>
            );
          })()}
          </div>{/* end worldRef */}

          {/* Refocus button — fixed to canvas, outside world transform */}
          <button
            onClick={refocus}
            className="absolute bottom-6 z-10 bg-[#1a110c]/90 border border-[#8a6331]/30 text-[#8a6331] hover:text-[#d1a561] hover:border-[#8a6331] text-[10px] px-3 py-1.5 rounded-sm uppercase tracking-wider font-bold flex items-center gap-1.5 shadow-lg backdrop-blur-sm transition-colors"
            style={{ left: '50%', transform: 'translateX(-50%)' }}
          >
            ↓ Latest
          </button>
        </section>


        {/* ── Right Panel: Prompt Composer (floating) ── */}
        <aside className="absolute right-0 top-0 h-full w-[440px] z-20 bg-[#1a110c]/95 backdrop-blur-md border-l border-[#8a6331]/20 flex flex-col shadow-[-5px_0_30px_rgba(0,0,0,0.7)]">
          {/* Player header — flip card (AnimatePresence: only one face mounted at a time, no height clash) */}
          <div className="p-4 border-b border-[#8a6331]/20 bg-[#0a0806]/50 shrink-0 overflow-hidden">
            <AnimatePresence mode="wait" initial={false}>
              {!showOpponentCard ? (
                <motion.div
                  key="front"
                  initial={{ rotateY: -90, opacity: 0 }}
                  animate={{ rotateY: 0, opacity: 1 }}
                  exit={{ rotateY: 90, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  style={{ transformOrigin: 'center' }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-9 h-9 rounded-full bg-[#2c1e16] flex items-center justify-center border border-[#4a3320] shrink-0">
                      <PlayerAvatar playerId={playerId} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-[#f4ebd8] text-sm">{playerId === 'A' ? gameState.playerAName : gameState.playerBName}</div>
                      <div className="text-[10px] text-[#a87b38] uppercase tracking-wider">Player {playerId}</div>
                    </div>
                    <button
                      onClick={() => setShowOpponentCard(true)}
                      className="flex items-center gap-1 px-2 py-1 rounded-sm border border-[#4a3320]/60 hover:border-[#8a6331]/60 text-[9px] text-[#4a3320] hover:text-[#8a6331] uppercase tracking-widest transition-colors"
                      title="View opponent card"
                    >
                      <PlayerAvatar playerId={opponentId} size="sm" />
                      <span>↺</span>
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest mb-1">Narrative Goal</div>
                      <p className="text-sm text-[#e8d5b0] leading-snug line-clamp-2">{you.goal}</p>
                    </div>
                    <div className="w-full h-px bg-[#4a3320]/50" />
                    <div>
                      <div className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest mb-1 flex items-center gap-1">
                        <EyeOff className="w-3 h-3" /> Side Quest
                      </div>
                      <p className="text-sm text-[#e8d5b0] leading-snug line-clamp-2">{you.sideQuestHint}</p>
                    </div>
                  </div>
                </motion.div>
              ) : (
                <motion.div
                  key="back"
                  initial={{ rotateY: 90, opacity: 0 }}
                  animate={{ rotateY: 0, opacity: 1 }}
                  exit={{ rotateY: -90, opacity: 0 }}
                  transition={{ duration: 0.22, ease: [0.4, 0, 0.2, 1] }}
                  style={{ transformOrigin: 'center' }}
                >
                  <div className="flex items-center gap-3 mb-3">
                    <div className="w-9 h-9 rounded-full bg-[#2c1e16] flex items-center justify-center border border-[#4a3320] shrink-0">
                      <PlayerAvatar playerId={opponentId} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="font-bold text-[#f4ebd8] text-sm">{opponentId === 'A' ? gameState.playerAName : gameState.playerBName}</div>
                      <div className="text-[10px] text-[#a87b38] uppercase tracking-wider">Player {opponentId}</div>
                    </div>
                    <button
                      onClick={() => setShowOpponentCard(false)}
                      className="flex items-center gap-1 px-2 py-1 rounded-sm border border-[#4a3320]/60 hover:border-[#8a6331]/60 text-[9px] text-[#4a3320] hover:text-[#8a6331] uppercase tracking-widest transition-colors"
                      title="Back to my card"
                    >
                      <PlayerAvatar playerId={playerId} size="sm" />
                      <span>↺</span>
                    </button>
                  </div>
                  <div className="space-y-2">
                    <div>
                      <div className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest mb-1">Narrative Goal</div>
                      <p className="text-sm text-[#e8d5b0] leading-snug line-clamp-2">{opponent.goal}</p>
                    </div>
                    <div className="w-full h-px bg-[#4a3320]/50" />
                    <div>
                      <div className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest mb-1 flex items-center gap-1">
                        <EyeOff className="w-3 h-3" /> Side Quest
                      </div>
                      {opponentSideQuestRevealed ? (
                        <p className="text-sm text-[#e8d5b0] leading-snug">{opponent.sideQuestHint}</p>
                      ) : (
                        <div className="border border-dashed border-[#4a3320]/60 rounded-sm p-2.5 relative overflow-hidden">
                          <div className="absolute inset-0 pointer-events-none opacity-[0.06]" style={{ backgroundImage: 'repeating-linear-gradient(45deg, #8a6331 0, #8a6331 1px, transparent 0, transparent 6px)', backgroundSize: '8px 8px' }} />
                          <div className="space-y-1.5 mb-1.5">
                            <div className="h-1.5 bg-[#4a3320]/40 rounded-sm w-full" />
                            <div className="h-1.5 bg-[#4a3320]/40 rounded-sm w-3/4" />
                            <div className="h-1.5 bg-[#4a3320]/40 rounded-sm w-1/2" />
                          </div>
                          <span className="text-[9px] text-[#4a3320]/70 uppercase tracking-[0.25em]">Classified</span>
                        </div>
                      )}
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </div>

          {/* Composer body */}
          <div className="flex-1 p-4 flex flex-col gap-3 min-h-0">

            {/* Goal */}
            <div>
              <label className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest block mb-1.5">Goal</label>
              <div className="flex gap-2">
                {(['main', 'side'] as const).map(g => (
                  <button
                    key={g}
                    onClick={() => setIntentGoalType(g)}
                    disabled={isGenerating}
                    className={`flex-1 py-1.5 text-xs font-bold rounded-sm border uppercase tracking-wider transition-all disabled:opacity-50 ${intentGoalType === g ? 'bg-[#d1a561] text-[#0a0806] border-[#d1a561]' : 'bg-[#0a0806] text-[#8a6331] border-[#4a3320] hover:border-[#8a6331]'}`}
                  >
                    {g === 'main' ? 'Main Objective' : 'Side Quest'}
                  </button>
                ))}
              </div>
            </div>

            {/* Tone */}
            <div>
              <label className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest block mb-1.5">Tone</label>
              <div className="flex gap-1.5">
                {['Calm', 'Subtle', 'Assertive', 'Aggressive'].map(t => (
                  <button
                    key={t}
                    onClick={() => setIntentTone(t)}
                    disabled={isGenerating}
                    className={`flex-1 py-1.5 text-xs font-bold rounded-sm border uppercase tracking-wider transition-all disabled:opacity-50 ${intentTone === t ? 'bg-[#d1a561] text-[#0a0806] border-[#d1a561]' : 'bg-[#0a0806] text-[#8a6331] border-[#4a3320] hover:border-[#8a6331]'}`}
                  >
                    {t}
                  </button>
                ))}
              </div>
            </div>

            {/* Intent Body */}
            <div className="flex-1 flex flex-col gap-1.5 min-h-0">
              <div className="flex items-center justify-between">
                <div>
                  <label className="text-[10px] font-bold text-[#d1a561] uppercase tracking-widest">Intent</label>
                  <p className="text-[10px] text-[#5a4024] mt-0.5">Steer the story — not a character.</p>
                </div>
                <div className="flex items-center gap-1">
                  <button
                    onClick={async () => {
                      if (showInspiration) { setShowInspiration(false); return; }
                      setShowInspiration(true);
                      if (inspirations.length === 0) await handleGetInspirations();
                    }}
                    disabled={isGenerating || loadingInspirations}
                    className={`p-1 rounded-sm transition-colors disabled:opacity-50 ${showInspiration ? 'text-[#d1a561]' : loadingInspirations ? 'text-[#d1a561]' : 'text-[#4a3320] hover:text-[#8a6331]'}`}
                    title="Get inspiration"
                  >
                    {loadingInspirations
                      ? <div className="w-3.5 h-3.5 border border-[#8a6331] border-t-[#d1a561] rounded-full animate-spin" />
                      : <span className="text-sm leading-none">💡</span>}
                  </button>
                  <button onClick={() => handleVoice()} disabled={isGenerating}
                    className={`p-1 rounded-sm transition-colors disabled:opacity-50 ${isVoiceActive ? 'text-[#e05555]' : 'text-[#a07840] hover:text-[#d1a561]'}`}
                    title={isVoiceActive ? 'Stop recording' : 'Voice input'}>
                    {isVoiceActive ? (
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="currentColor">
                        <rect x="0" y="5" width="2" height="4" rx="1">
                          <animate attributeName="height" values="4;10;4" dur="0.8s" repeatCount="indefinite" />
                          <animate attributeName="y" values="5;2;5" dur="0.8s" repeatCount="indefinite" />
                        </rect>
                        <rect x="3" y="3" width="2" height="8" rx="1">
                          <animate attributeName="height" values="8;4;8" dur="0.8s" begin="0.15s" repeatCount="indefinite" />
                          <animate attributeName="y" values="3;5;3" dur="0.8s" begin="0.15s" repeatCount="indefinite" />
                        </rect>
                        <rect x="6" y="1" width="2" height="12" rx="1">
                          <animate attributeName="height" values="12;6;12" dur="0.8s" begin="0.05s" repeatCount="indefinite" />
                          <animate attributeName="y" values="1;4;1" dur="0.8s" begin="0.05s" repeatCount="indefinite" />
                        </rect>
                        <rect x="9" y="3" width="2" height="8" rx="1">
                          <animate attributeName="height" values="8;3;8" dur="0.8s" begin="0.2s" repeatCount="indefinite" />
                          <animate attributeName="y" values="3;5.5;3" dur="0.8s" begin="0.2s" repeatCount="indefinite" />
                        </rect>
                        <rect x="12" y="5" width="2" height="4" rx="1">
                          <animate attributeName="height" values="4;9;4" dur="0.8s" begin="0.1s" repeatCount="indefinite" />
                          <animate attributeName="y" values="5;2.5;5" dur="0.8s" begin="0.1s" repeatCount="indefinite" />
                        </rect>
                      </svg>
                    ) : (
                      <Mic className="w-3.5 h-3.5" />
                    )}
                  </button>
                </div>
              </div>

              {/* Voice interim transcript */}
              {voiceInterim && (
                <div className="px-1 py-1 text-xs text-[#8a6331] italic opacity-75 truncate">
                  {voiceInterim}…
                </div>
              )}

              {/* Inspiration Carousel */}
              <AnimatePresence>
                {showInspiration && inspirations.length > 0 && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="bg-[#0a0806] border border-[#4a3320]/80 rounded-sm px-3 py-2">
                      <AnimatePresence mode="wait">
                        <motion.p
                          key={inspirationIdx}
                          initial={{ opacity: 0, x: 14 }}
                          animate={{ opacity: 1, x: 0 }}
                          exit={{ opacity: 0, x: -14 }}
                          transition={{ duration: 0.18 }}
                          className="text-sm text-[#e8d5b0] leading-snug line-clamp-2"
                        >
                          {inspirations[inspirationIdx]}
                        </motion.p>
                      </AnimatePresence>
                      <div className="flex items-center justify-between mt-1.5">
                        <div className="flex gap-1.5 items-center">
                          {inspirations.map((_, i) => (
                            <button
                              key={i}
                              onClick={() => setInspirationIdx(i)}
                              className={`w-1.5 h-1.5 rounded-full transition-colors ${i === inspirationIdx ? 'bg-[#d1a561]' : 'bg-[#4a3320] hover:bg-[#8a6331]'}`}
                            />
                          ))}
                        </div>
                        <button
                          onClick={() => {
                            const insp = inspirations[inspirationIdx];
                            setIntentBody(prev => {
                              const marker = '// Constraints';
                              const idx = prev.indexOf(marker);
                              if (idx !== -1) {
                                return prev.slice(0, idx).trimEnd() + '\n' + insp + '\n\n' + prev.slice(idx);
                              }
                              return prev.trimEnd() + '\n' + insp;
                            });
                            setInspirations([]);
                            setInspirationIdx(0);
                            setShowInspiration(false);
                          }}
                          disabled={false}
                          className="text-[10px] font-bold text-[#d1a561] hover:text-[#f4ebd8] uppercase tracking-wider transition-colors"
                        >
                          Apply →
                        </button>
                      </div>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <textarea
                value={intentBody}
                onChange={e => setIntentBody(e.target.value)}
                disabled={isGenerating}
                className="flex-1 min-h-[80px] w-full bg-[#0a0806] border border-[#4a3320] focus:border-[#8a6331] rounded-sm p-3 text-sm text-[#f4ebd8] leading-relaxed resize-none focus:outline-none disabled:opacity-50 transition-colors font-mono"
              />

              {/* Example nudges */}
              <div className="flex flex-wrap gap-1.5">
                {[
                  'Let suspicion deepen before anything surfaces',
                  'Push toward a risky reveal',
                  'Delay certainty — raise the pressure',
                  'Let the calm become unstable',
                  'Shift the balance of trust without open conflict',
                ].map(ex => (
                  <button
                    key={ex}
                    disabled={isGenerating}
                    onClick={() => setIntentBody(prev => {
                      const marker = '// Constraints';
                      const idx = prev.indexOf(marker);
                      return idx !== -1
                        ? prev.slice(0, idx).trimEnd() + '\n' + ex + '\n\n' + prev.slice(idx)
                        : prev.trimEnd() + '\n' + ex;
                    })}
                    className="text-[10px] text-[#5a4024] hover:text-[#8a6331] border border-[#2a1a0e] hover:border-[#4a3320] rounded-sm px-2 py-0.5 transition-colors disabled:opacity-30 leading-tight"
                  >
                    {ex}
                  </button>
                ))}
              </div>

              {/* Diagnostics */}
              <div className="flex justify-end shrink-0">
                <button
                  onClick={() => setDebugInfo(prev => prev ? { ...prev, show: !prev.show } : null)}
                  className="text-[10px] text-[#4a3320] hover:text-[#8a6331] flex items-center gap-1 transition-colors uppercase tracking-widest font-bold"
                >
                  <Zap className="w-3 h-3" /> Diagnostics
                </button>
              </div>
              <AnimatePresence>
                {debugInfo && debugInfo.show && (
                  <motion.div
                    initial={{ opacity: 0, height: 0 }}
                    animate={{ opacity: 1, height: 'auto' }}
                    exit={{ opacity: 0, height: 0 }}
                    className="shrink-0 p-4 bg-[#0a0806] border border-[#4a3320] rounded-sm text-xs text-[#a87b38] break-words overflow-hidden shadow-inner"
                  >
                    <div className="flex justify-between mb-2 border-b border-[#4a3320] pb-2">
                      <span className="text-[#8a6331]">Text Model:</span>
                      <span className={debugInfo.textModel === 'mock' ? 'text-amber-500' : 'text-emerald-500'}>{debugInfo.textModel}</span>
                    </div>
                    <div className="flex justify-between mb-2">
                      <span className="text-[#8a6331]">Image Model:</span>
                      <span className={debugInfo.imageModel === 'placeholder' ? 'text-amber-500' : 'text-emerald-500'}>{debugInfo.imageModel}</span>
                    </div>
                    {debugInfo.outcome && (() => {
                      const o = debugInfo.outcome;
                      const fmt = (n: number) => n > 0 ? `+${n}` : String(n);
                      const phaseChanged = o.prevPhase !== o.newPhase;
                      const momChanged   = o.prevMomentum !== o.newMomentum;
                      const row = (label: string, val: React.ReactNode, highlight = false) => (
                        <div key={label} className="flex justify-between gap-2">
                          <span className="text-[#5a4024]">{label}</span>
                          <span className={highlight ? 'text-[#d1a561] font-bold' : 'text-[#a87b38]'}>{val}</span>
                        </div>
                      );
                      return (
                        <div className="mt-3 border-t border-[#4a3320] pt-3 space-y-1">
                          <div className="text-[#8a6331] font-bold uppercase tracking-wider mb-2">
                            Outcome Engine — T{o.turn} / {o.player}
                          </div>
                          {row('prevProgressA',    o.prevProgressA.toFixed(1))}
                          {row('GM raw target',    o.gmRawTarget)}
                          {row('baseDelta',        o.baseDelta.toFixed(1))}
                          {row('causal',           o.isCausallySupported ? '✓ yes' : '✗ no', !o.isCausallySupported)}
                          {row('bonus',            o.bonusAwarded ? `✓ +${o.bonusAmount}` : '—')}
                          <div className="border-t border-[#2a1a0e] my-1" />
                          {row('momentum',         `${fmt(o.prevMomentum)} → ${fmt(o.newMomentum)}`, momChanged)}
                          {row('phase',            `${o.prevPhase} → ${o.newPhase}`, phaseChanged)}
                          {row('streak',           `${o.streakPlayer ?? 'null'}×${o.streakCount}`)}
                          <div className="border-t border-[#2a1a0e] my-1" />
                          {row('engineProgressA',  o.engineProgressA.toFixed(1), true)}
                        </div>
                      );
                    })()}
                    {debugInfo.lastError && (
                      <div className="mt-3 text-red-400 border-t border-[#4a3320] pt-3">
                        <span className="text-red-500 font-bold block mb-1 uppercase tracking-wider">Last Error:</span>
                        {debugInfo.lastError}
                      </div>
                    )}
                  </motion.div>
                )}
              </AnimatePresence>
            </div>
          </div>

          {/* Fixed submit footer */}
          <div className="shrink-0 p-4 border-t border-[#8a6331]/20 bg-[#0a0806]/50">
            {/* Timer — only shown when it's my turn */}
            {isMyTurn && !isGenerating && !gameState.isGameOver && (() => {
              const mins = Math.floor(timeLeft / 60);
              const secs = timeLeft % 60;
              const label = `${mins}:${String(secs).padStart(2, '0')}`;
              const urgent = timeLeft <= 30;
              const warn = timeLeft <= 60 && !urgent;
              return (
                <div className={`flex items-center justify-between mb-3 px-1 ${urgent ? 'animate-pulse' : ''}`}>
                  <span className="text-[10px] font-bold uppercase tracking-widest"
                    style={{ color: urgent ? '#e05555' : warn ? '#d1a561' : '#4a3320' }}>
                    Time Remaining
                  </span>
                  <span className="font-mono text-sm font-bold tabular-nums"
                    style={{ color: urgent ? '#e05555' : warn ? '#d1a561' : '#8a6331' }}>
                    {label}
                  </span>
                </div>
              );
            })()}
            <button
              onClick={() => handleGenerate()}
              disabled={!isMyTurn || isGenerating}
              className="w-full py-3 bg-[#d1a561] hover:bg-[#e2b875] text-[#0a0806] font-bold rounded-sm flex items-center justify-center gap-2 transition-colors disabled:opacity-50 disabled:cursor-not-allowed uppercase tracking-[0.2em] text-xs shadow-md border border-[#f4ebd8]/20"
            >
              {!isMyTurn ? 'Awaiting Opponent' : isGenerating ? 'Generating…' : gameState.isGameOver ? 'Final Outcome' : 'Submit Intent'}
              {isMyTurn && !isGenerating && !gameState.isGameOver && <ChevronRight className="w-4 h-4" />}
            </button>
          </div>
        </aside>
      </main>
      
      {/* Ending Frame — shown before outcome modal */}
      <AnimatePresence>
        {showEndingFrame && gameState.isGameOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 bg-[#0a0806] flex flex-col items-center justify-center overflow-hidden"
          >
            {/* Background image */}
            {finalImageUrl && (
              <div className="absolute inset-0">
                <img src={finalImageUrl} alt="Ending" className="w-full h-full object-cover opacity-35" />
                <div className="absolute inset-0 bg-gradient-to-t from-[#0a0806] via-[#0a0806]/55 to-[#0a0806]/20" />
              </div>
            )}
            {/* Noise grain */}
            <div className="absolute inset-0 pointer-events-none opacity-40 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)' opacity='0.08'/%3E%3C/svg%3E")` }} />

            <div className="relative z-10 max-w-2xl w-full px-10 text-center flex flex-col items-center gap-10">
              <div className="text-[10px] uppercase tracking-[0.4em] text-[#8a6331]">— Epilogue —</div>
              <p className="text-[#f4ebd8]/90 text-lg leading-relaxed font-light">{finalText}</p>
              <button
                onClick={() => { setShowEndingFrame(false); setShowOutcomeModal(true); }}
                className="px-10 py-3 border border-[#d1a561]/60 text-[#d1a561] text-xs font-bold uppercase tracking-[0.3em] hover:bg-[#d1a561]/10 transition-colors rounded-sm"
              >
                Reveal Outcome
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Game Over Overlay */}
      <AnimatePresence>
        {showOutcomeModal && gameState.isGameOver && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="fixed inset-0 z-50 bg-[#0a0806]/90 flex flex-col items-center justify-center p-8 backdrop-blur-md"
          >
            <div className="absolute inset-0 pointer-events-none opacity-30 mix-blend-multiply" style={{ backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 200 200' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noiseFilter'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noiseFilter)' opacity='0.08'/%3E%3C/svg%3E")` }}></div>
            
            <div className="max-w-md w-full bg-[#1a110c] border border-[#d1a561]/50 rounded-sm p-10 shadow-[0_0_40px_rgba(209,165,97,0.15)] text-center relative z-10">
              {/* Corner ornaments */}
              <div className="absolute top-2 left-2 w-4 h-4 border-t border-l border-[#8a6331]"></div>
              <div className="absolute top-2 right-2 w-4 h-4 border-t border-r border-[#8a6331]"></div>
              <div className="absolute bottom-2 left-2 w-4 h-4 border-b border-l border-[#8a6331]"></div>
              <div className="absolute bottom-2 right-2 w-4 h-4 border-b border-r border-[#8a6331]"></div>
              
              <h2 className="text-4xl font-bold mb-6 text-[#d1a561]">
                Final Outcome
              </h2>
              <p className="text-[#f4ebd8] mb-10 text-lg">
                After 10 turns of intense psychological warfare, the story has reached its conclusion.
              </p>
              
              <div className="flex flex-col gap-5 mb-10">
                <div className="bg-[#0a0806] p-5 rounded-sm border border-[#4a3320] shadow-inner relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#d1a561]"></div>
                  <div className="text-xs text-[#8a6331] mb-2 uppercase tracking-widest font-bold">Ending A Probability</div>
                  <div className="text-4xl font-bold text-[#f4ebd8]">{parseFloat(gameState.progressA.toFixed(1))}%</div>
                </div>
                <div className="bg-[#0a0806] p-5 rounded-sm border border-[#4a3320] shadow-inner relative overflow-hidden">
                  <div className="absolute left-0 top-0 bottom-0 w-1 bg-[#8a6331]"></div>
                  <div className="text-xs text-[#8a6331] mb-2 uppercase tracking-widest font-bold">Ending B Probability</div>
                  <div className="text-4xl font-bold text-[#a87b38]">{parseFloat((100 - gameState.progressA).toFixed(1))}%</div>
                </div>
              </div>

              <div className="text-2xl font-bold text-[#d1a561] mb-10 uppercase tracking-widest border-y border-[#8a6331]/30 py-4">
                {gameState.progressA > 50 ? 'Ending A Achieved!' : gameState.progressA < 50 ? 'Ending B Achieved!' : 'Stalemate!'}
              </div>

              <div className="flex flex-col gap-3">
                <button
                  onClick={() => setShowOutcomeModal(false)}
                  className="w-full py-4 bg-[#2a1c10] hover:bg-[#3a2818] text-[#d1a561] font-bold rounded-sm transition-colors uppercase tracking-[0.2em] border border-[#8a6331]/60"
                >
                  Review Story Canvas
                </button>
                <button
                  onClick={() => window.location.hash = ''}
                  className="w-full py-4 bg-[#d1a561] hover:bg-[#e2b875] text-[#0a0806] font-bold rounded-sm transition-colors uppercase tracking-[0.2em] shadow-md border border-[#f4ebd8]/20"
                >
                  Return to Story Shelf
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

    </div>
  );
}

