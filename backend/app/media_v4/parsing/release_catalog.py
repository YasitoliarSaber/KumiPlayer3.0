"""经官方发行资料核验的完整作品别名；不含 Provider ID 或用户学习结果。

规则数据与匹配算法分离。每个条目必须有出处，重名的不同发行不得共用无条件
别名；增补知识后须提升 V4Parser.VERSION，历史解析及 confirmed 不原位更新。
"""

from dataclasses import dataclass


@dataclass(frozen=True, slots=True)
class VerifiedRelease:
    key: str
    title: str
    year: int
    aliases: tuple[str, ...]
    source_urls: tuple[str, ...]
    series_title: str = ""
    release_form: str = "theatrical_movie"


VERIFIED_RELEASES = (
    VerifiedRelease(
        "tamako-love-story", "玉子爱情故事", 2014,
        ("Tamako Love Story", "たまこラブストーリー"),
        ("https://www.kyotoanimation.co.jp/en/works/tamakoMovie/",), "玉子市场",
    ),
    VerifiedRelease(
        "euphonium-chikai-no-finale", "吹响吧！上低音号 誓言的终章", 2019,
        ("Hibike! Euphonium Chikai no Finale", "Sound! Euphonium The Movie Our Promise A Brand New Day",
         "響け！ユーフォニアム 誓いのフィナーレ"),
        ("https://www.kyotoanimation.co.jp/en/works/euphoniumCF/",), "吹响吧！上低音号",
    ),
    VerifiedRelease(
        "chunibyo-take-on-me", "中二病也要谈恋爱！Take On Me", 2018,
        ("Chuunibyou demo Koi ga Shitai! Take On Me", "Chuunibyou demo Koi ga Shitai! Movie Take On Me",
         "Love, Chunibyo and Other Delusions! Take On Me", "Love, Chunibyo & Other Delusions! Take On Me",
         "中二病でも恋がしたい！Take On Me"),
        ("https://www.shochiku.co.jp/cinema/lineup/anime-chu-2/",), "中二病也要谈恋爱！",
    ),
    VerifiedRelease(
        "violet-eternity", "紫罗兰永恒花园 外传 永远与自动手记人偶", 2019,
        ("Violet Evergarden Eien to Jidou Shuki Ningyou", "Violet Evergarden Gaiden Eien to Jidou Shuki Ningyou",
         "Violet Evergarden Eternity and the Auto Memory Doll", "ヴァイオレット・エヴァーガーデン 外伝 永遠と自動手記人形"),
        ("https://www.kyotoanimation.co.jp/en/works/violetG/",), "紫罗兰永恒花园",
    ),
    VerifiedRelease(
        "euphonium-ensemble-contest", "吹响吧！上低音号 合奏比赛", 2023,
        ("Hibike! Euphonium Ensemble Contest", "Hibike! Euphonium Ensamble Contest",
         "Sound! Euphonium Special Feature Ensemble Contest", "響け！ユーフォニアム アンサンブルコンテスト"),
        ("https://www.kyotoanimation.co.jp/en/works/eupho05/",), "吹响吧！上低音号", "theatrical_special",
    ),
    VerifiedRelease(
        "euphonium-todoketai-melody", "吹响吧！上低音号 想要传达的旋律", 2017,
        ("Hibike! Euphonium Todoketai Melody", "Sound! Euphonium The Movie May the melody reach you!",
         "響け！ユーフォニアム 届けたいメロディ"),
        ("https://movie2.anime-eupho.com/",), "吹响吧！上低音号",
    ),
    VerifiedRelease(
        "liz-and-the-blue-bird", "利兹与青鸟", 2018,
        ("Liz to Aoi Tori", "Liz and the Blue Bird", "リズと青い鳥"),
        ("https://www.kyotoanimation.co.jp/en/works/liz/",), "吹响吧！上低音号",
    ),
    VerifiedRelease(
        "maidragon-lonely-dragon", "小林家的龙女仆 怕寂寞的龙", 2025,
        ("Kobayashi-san Chi no Maid Dragon Samishigariya no Ryuu",
         "Miss Kobayashi's Dragon Maid A lonely dragon wants to be loved", "小林さんちのメイドラゴン さみしがりやの竜"),
        ("https://www.kyotoanimation.co.jp/en/works/maidragon03/",), "小林家的龙女仆",
    ),
    VerifiedRelease(
        "tsurune-first-shot", "弦音 起始的一箭", 2022,
        ("Tsurune Hajimari no Issha", "Tsurune The Movie The First Shot", "ツルネ はじまりの一射"),
        ("https://www.kyotoanimation.co.jp/en/works/tsurune02/",), "弦音",
    ),
    VerifiedRelease(
        "a-silent-voice", "声之形", 2016,
        ("Koe no Katachi", "A Silent Voice", "A Silent Voice The Movie", "聲の形"),
        ("https://www.kyotoanimation.co.jp/en/works/koeMovie/",),
    ),
)
