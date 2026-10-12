@main
struct ProviderCyclerTests {
    static func main() {
        precondition(ProviderCycler.nextIndex(currentIndex: 0, offset: 1, count: 4) == 1)
        precondition(ProviderCycler.nextIndex(currentIndex: 0, offset: -1, count: 4) == 3)
        precondition(ProviderCycler.nextIndex(currentIndex: 3, offset: 1, count: 4) == 0)
        precondition(ProviderCycler.nextIndex(currentIndex: 0, offset: -1, count: 1) == nil)
        precondition(ProviderCycler.nextIndex(currentIndex: 0, offset: 1, count: 0) == nil)
    }
}
