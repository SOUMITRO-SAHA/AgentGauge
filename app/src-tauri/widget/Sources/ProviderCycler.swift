enum ProviderCycler {
    static func nextIndex(currentIndex: Int, offset: Int, count: Int) -> Int? {
        guard count > 1 else { return nil }
        let start = ((currentIndex % count) + count) % count
        let step = offset % count
        return (start + step + count) % count
    }
}
