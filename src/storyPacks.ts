export type PlayerId = 'A' | 'B';

export interface PlayerDef {
  id: PlayerId;
  defaultName: string;
  avatar: string;
  goal: string;
  sideQuest: string;
  sideQuestHint: string;
}

export interface StoryPack {
  id: string;
  title: string;
  hook: string;
  tags: string[];
  coverUrl: string;
  prologue: string;
  characterIdentityLock: string;
  visualStyleLock: string;
  anchors: string[];
  playerA: PlayerDef;
  playerB: PlayerDef;
}

export const storyPacks: StoryPack[] = [
  {
    id: 'neon-shadow',
    title: 'Neon Shadow',
    hook: 'OmniTech’s data core hides the truth behind the citywide power grid collapse. Two agents infiltrate the machine room. Alarms blare. They have only ten minutes.',
    tags: ['Cyberpunk', 'Infiltration', 'Mystery'],
    coverUrl: '/covers/book2.jpg',
    prologue: 'Time: Late night, November 4, 2142. Location: the cooling chamber 300 meters beneath OmniTech in District 7, New Kyoto. Two agents have just cut the main power. The air is thick with the smell of ozone. In the terminal before them lies an encrypted ledger proving that the company’s executives deliberately cut power to the slums in exchange for government subsidies. Security drones are closing in. They have only ten minutes to decide the fate of the data.',
    characterIdentityLock: 'Agent A: Wearing a sleek black stealth suit, glowing blue visor. Agent B: Wearing a heavy tactical vest, carrying a portable hacking deck.',
    visualStyleLock: 'Cyberpunk aesthetic, neon lights, dark shadows, high contrast, futuristic tech, cinematic lighting.',
    anchors: ['Cooling Chamber', 'Encrypted Ledger Terminal', 'Security Drones'],
    playerA: {
      id: 'A',
      defaultName: 'Agent Alpha',
      avatar: '🥷',
      goal: 'Ending A: Expose the Truth — The ledger is broadcast citywide. OmniTech\'s cover-up becomes public record.',
      sideQuest: 'The cooling system gets sabotaged during the extraction — leaving no trace for OmniTech\'s investigators.',
      sideQuestHint: 'Steering the scene toward facility sabotage while the data transfer unfolds yields a bonus.'
    },
    playerB: {
      id: 'B',
      defaultName: 'Agent Beta',
      avatar: '💻',
      goal: 'Ending B: Blackmail the Executives — The ledger vanishes into private hands. OmniTech pays to keep its secrets buried.',
      sideQuest: 'The prototype drone control chip from the adjacent lab changes hands before the exit.',
      sideQuestHint: 'Steering the scene toward the adjacent lab while the leverage is secured yields a bonus.'
    }
  },
  {
    id: 'echoes-of-the-abyss',
    title: 'Echoes of the Abyss',
    hook: 'A research submersible that vanished ten years ago suddenly transmits a distress signal. The rescue team descends into the Mariana Trench, only to find a strange recording inside the vessel.',
    tags: ['Deep-Sea Horror', 'Science Fiction', 'Psychological Tension'],
    coverUrl: '/covers/book3.jpg',
    prologue: 'Time: 2035. Location: the floor of the Mariana Trench, under crushing water pressure. The rescue submersible Proteus I has just docked with the Explorer, which disappeared ten years ago. When the hatch opens, there are no bodies inside—only walls covered in deranged graffiti and a black box looping an eerie low-frequency noise. The pressure of the deep sea is suffocating, and the real threat seems not to come from within the vessel, but from some indescribable force beyond it.',
    characterIdentityLock: 'Rescuer A (The Captain): Wearing a heavy deep-sea diving suit, helmet light on. Rescuer B (The Scientist): Wearing a standard jumpsuit, holding a portable sonar scanner.',
    visualStyleLock: 'Deep-sea horror, murky water, claustrophobic interiors, bioluminescent glow, cinematic lighting.',
    anchors: ['The Explorer Submersible', 'Deranged Graffiti', 'The Black Box'],
    playerA: {
      id: 'A',
      defaultName: 'The Captain',
      avatar: '⚓',
      goal: 'Ending A: Secure the Vessel — The Explorer is towed to the surface intact. Whatever it carries becomes part of the official record.',
      sideQuest: 'The captain\'s logbook is recovered from the flooded lower deck, filling in the missing years.',
      sideQuestHint: 'Steering a character toward the flooded lower deck while the vessel is being secured yields a bonus.'
    },
    playerB: {
      id: 'B',
      defaultName: 'The Scientist',
      avatar: '🔬',
      goal: 'Ending B: Destroy the Anomaly — The Explorer goes dark at the bottom of the trench. What happened here stays in the deep.',
      sideQuest: 'The data core from the looping black box is extracted before everything sinks.',
      sideQuestHint: 'Steering a character toward the black box while the scuttling is prepared yields a bonus.'
    }
  }
];
